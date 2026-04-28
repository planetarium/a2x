/**
 * A2XClient — Client for communicating with remote A2A agents.
 *
 * Supports both v0.3 and v1.0 protocol versions with auto-detection.
 * Protocol version is determined from the AgentCard structure.
 */

import type { LocalAccount } from 'viem';
import type { AgentCardV03, AgentCardV10 } from '../types/agent-card.js';
import type { Task } from '../types/task.js';
import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types/task.js';
import type { SendMessageParams, JSONRPCRequest } from '../types/jsonrpc.js';
import type { JSONRPCResponse } from '../types/jsonrpc.js';
import { A2A_METHODS } from '../types/jsonrpc.js';
import type { A2AError } from '../types/errors.js';
import {
  TaskNotFoundError,
  TaskNotCancelableError,
  InternalError,
  InvalidParamsError,
  InvalidRequestError,
  MethodNotFoundError,
  JSONParseError,
  PushNotificationNotSupportedError,
  UnsupportedOperationError,
  ContentTypeNotSupportedError,
  InvalidAgentResponseError,
  AuthenticatedExtendedCardNotConfiguredError,
  A2A_ERROR_CODES,
} from '../types/errors.js';
import { TaskState } from '../types/task.js';
import type { ResolvedAgentCard } from './agent-card-resolver.js';
import {
  resolveAgentCard,
  detectProtocolVersion,
  getAgentEndpointUrl,
} from './agent-card-resolver.js';
import { getResponseParser } from './response-parser.js';
import type { ResponseParser } from './response-parser.js';
import { parseSSEStream } from './sse-parser.js';
import type { AuthProvider } from './auth-provider.js';
import type { AuthScheme, AuthRequestContext } from './auth-scheme.js';
import { normalizeRequirements } from './auth-normalizer.js';
import {
  X402_EXTENSION_URI,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
} from '../x402/constants.js';
import {
  signX402Payment,
  getX402PaymentRequirements,
  getX402Receipts,
  type SignedX402Payment,
} from '../x402/client.js';
import { X402PaymentFailedError } from '../x402/errors.js';
import type {
  X402PaymentRequirements,
  X402PaymentRequiredResponse,
} from '../x402/types.js';

// ─── Types ───

/**
 * a2a-x402 v0.2 client options. When supplied to `A2XClientOptions.x402`,
 * `A2XClient` transparently runs the Standalone Flow: when the agent
 * returns `payment-required`, the client signs one of the merchant's
 * `accepts[]` requirements and resubmits with the signed payload, then
 * surfaces only the final task to the caller.
 *
 * Spec: `specification/a2a-x402-v0.2.md`.
 */
export interface A2XClientX402Options {
  /** viem LocalAccount used to sign EIP-3009 authorizations. */
  signer: LocalAccount;
  /**
   * Maximum atomic units the client is willing to authorize per
   * requirement. Default: no cap.
   *
   * Always enforced — any requirement whose `maxAmountRequired` exceeds
   * this is filtered out before the selector runs, so a custom
   * `selectRequirement` only sees the affordable subset. If nothing
   * remains, signing throws `X402NoSupportedRequirementError`.
   */
  maxAmount?: bigint;
  /**
   * Custom predicate to pick a requirement out of the merchant's
   * `accepts[]` (already filtered by `maxAmount` if set). Default:
   * prefer `scheme === 'exact'`, else first remaining.
   */
  selectRequirement?: (
    requirements: X402PaymentRequirements[],
  ) => X402PaymentRequirements | undefined;
  /**
   * Hook invoked after the merchant publishes `payment-required` and
   * before the client signs. Useful for prompting the user to confirm.
   * Throw to abort the flow — the caller observes the merchant's
   * unmodified `payment-required` task (blocking) or a stream that
   * closes after the `payment-required` event (streaming).
   */
  onPaymentRequired?: (
    required: X402PaymentRequiredResponse,
  ) => void | Promise<void>;
}

export interface A2XClientOptions {
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  authProvider?: AuthProvider;
  /**
   * A2A extension URIs the client wants to activate. Emitted as a
   * comma-separated `X-A2A-Extensions` HTTP header on every JSON-RPC
   * request per a2a-x402 v0.2 §8 and the A2A core extension activation
   * convention.
   *
   * You can also register extensions at runtime via `registerExtension()`.
   *
   * When `x402` is supplied below, `X402_EXTENSION_URI` is added here
   * automatically — there's no need to list it manually.
   */
  extensions?: string[];
  /**
   * Enables transparent a2a-x402 v0.2 payment handling. Omit when calling
   * agents that don't gate on x402; the client behaves as a plain A2A
   * client in that case.
   */
  x402?: A2XClientX402Options;
}

// ─── Error Code → Error Class Mapping ───

const ERROR_CODE_MAP: Record<number, new (message?: string, data?: unknown) => A2AError> = {
  [A2A_ERROR_CODES.JSON_PARSE_ERROR]: JSONParseError,
  [A2A_ERROR_CODES.INVALID_REQUEST]: InvalidRequestError,
  [A2A_ERROR_CODES.METHOD_NOT_FOUND]: MethodNotFoundError,
  [A2A_ERROR_CODES.INVALID_PARAMS]: InvalidParamsError,
  [A2A_ERROR_CODES.INTERNAL_ERROR]: InternalError,
  [A2A_ERROR_CODES.TASK_NOT_FOUND]: TaskNotFoundError,
  [A2A_ERROR_CODES.TASK_NOT_CANCELABLE]: TaskNotCancelableError,
  [A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED]: PushNotificationNotSupportedError,
  [A2A_ERROR_CODES.UNSUPPORTED_OPERATION]: UnsupportedOperationError,
  [A2A_ERROR_CODES.CONTENT_TYPE_NOT_SUPPORTED]: ContentTypeNotSupportedError,
  [A2A_ERROR_CODES.INVALID_AGENT_RESPONSE]: InvalidAgentResponseError,
  [A2A_ERROR_CODES.AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED]: AuthenticatedExtendedCardNotConfiguredError,
};

// ─── v0.3 Request Formatting ───

/**
 * Convert internal Part format to v0.3 wire format.
 *
 * v0.3 TextPart: { kind: "text", text: "..." }
 * v0.3 FilePart: { kind: "file", file: { uri?, bytes?, mimeType?, name? } }
 * v0.3 DataPart: { kind: "data", data: {...} }
 */
function formatPartToV03(part: Record<string, unknown>): Record<string, unknown> {
  // TextPart
  if ('text' in part) {
    const result: Record<string, unknown> = { kind: 'text', text: part.text };
    if (part.metadata) result.metadata = part.metadata;
    return result;
  }

  // DataPart
  if ('data' in part) {
    const result: Record<string, unknown> = { kind: 'data', data: part.data };
    if (part.metadata) result.metadata = part.metadata;
    return result;
  }

  // FilePart: flatten → nested { file: { uri/bytes, mimeType, name } }
  if ('raw' in part || 'url' in part) {
    const file: Record<string, unknown> = {};
    if (part.raw) file.bytes = part.raw;
    if (part.url) file.uri = part.url;
    if (part.mediaType) file.mimeType = part.mediaType;
    if (part.filename) file.name = part.filename;

    const result: Record<string, unknown> = { kind: 'file', file };
    if (part.metadata) result.metadata = part.metadata;
    return result;
  }

  // Unknown part — pass through with kind
  if (!part.kind) part.kind = 'text';
  return part;
}

// ─── A2XClient ───

export class A2XClient {
  private readonly _urlOrCard: string | AgentCardV03 | AgentCardV10;
  private readonly _fetchImpl: typeof globalThis.fetch;
  private readonly _headers: Record<string, string>;
  private readonly _authProvider?: AuthProvider;
  private readonly _extensions: Set<string>;
  private readonly _x402?: A2XClientX402Options;
  private _resolved: ResolvedAgentCard | null = null;
  private _parser: ResponseParser | null = null;
  private _endpointUrl: string | null = null;
  private _resolvedSchemes?: AuthScheme[];
  private _requestId = 0;

  constructor(
    urlOrAgentCard: string | AgentCardV03 | AgentCardV10,
    options?: A2XClientOptions,
  ) {
    this._urlOrCard = urlOrAgentCard;
    this._fetchImpl = options?.fetch ?? globalThis.fetch;
    this._headers = options?.headers ?? {};
    this._authProvider = options?.authProvider;
    this._extensions = new Set(options?.extensions ?? []);
    this._x402 = options?.x402;
    if (this._x402) {
      // Spec a2a-x402 v0.2 §8: clients MUST activate the extension via
      // `X-A2A-Extensions`. Auto-register so callers don't have to.
      this._extensions.add(X402_EXTENSION_URI);
    }
  }

  /**
   * Register an A2A extension URI to be included in the
   * `X-A2A-Extensions` header on subsequent requests. Idempotent.
   */
  registerExtension(uri: string): void {
    this._extensions.add(uri);
  }

  /** Read-only view of currently activated extension URIs. */
  get activatedExtensions(): readonly string[] {
    return [...this._extensions];
  }

  // ─── Public Methods ───

  /**
   * Send a message and wait for the complete response.
   * Uses JSON-RPC method `message/send`.
   *
   * When `options.x402` is set on this client and the agent responds with
   * `payment-required`, the dance is run transparently — the returned
   * task is the final settled task.
   */
  async sendMessage(params: SendMessageParams): Promise<Task> {
    const first = await this._sendMessageOnce(params);
    if (!this._x402) return first;
    if (first.status.state !== 'input-required') return first;

    const required = getX402PaymentRequirements(first);
    if (!required) return first;

    if (this._x402.onPaymentRequired) {
      await this._x402.onPaymentRequired(required);
    }

    const signed = await this._signX402(first);

    const followup: SendMessageParams = {
      ...params,
      message: {
        ...params.message,
        messageId: globalThis.crypto.randomUUID(),
        taskId: first.id,
        contextId: first.contextId,
        metadata: {
          ...(params.message.metadata ?? {}),
          ...signed.metadata,
        },
      },
    };

    const second = await this._sendMessageOnce(followup);

    const receipts = getX402Receipts(second);
    const failed = receipts.find((r) => !r.success);
    if (failed) {
      const errorCode =
        ((second.status.message?.metadata as Record<string, unknown> | undefined)?.[
          X402_METADATA_KEYS.ERROR
        ] as string | undefined) ?? 'UNKNOWN';
      throw new X402PaymentFailedError(
        failed.errorReason ?? 'Payment failed',
        errorCode,
        { transaction: failed.transaction, network: failed.network },
      );
    }

    return second;
  }

  /**
   * Send a message and stream the response via SSE.
   * Uses JSON-RPC method `message/stream`.
   *
   * When `options.x402` is set on this client and the first stream emits
   * `payment-required`, the dance runs transparently: that event is
   * yielded to the caller, the first stream is abandoned, and the
   * follow-up stream's events (`payment-verified` → `working` →
   * artifacts → `payment-completed`) are yielded on the same generator.
   */
  async *sendMessageStream(
    params: SendMessageParams,
    signal?: AbortSignal,
  ): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    if (!this._x402) {
      yield* this._sendMessageStreamOnce(params, signal);
      return;
    }

    let firstTask: Task | undefined;
    for await (const event of this._sendMessageStreamOnce(params, signal)) {
      yield event;
      if ('status' in event && event.status?.state === 'input-required') {
        const meta = event.status.message?.metadata as
          | Record<string, unknown>
          | undefined;
        if (meta?.[X402_METADATA_KEYS.STATUS] === X402_PAYMENT_STATUS.REQUIRED) {
          firstTask = {
            id: event.taskId,
            contextId: event.contextId,
            status: event.status,
          } as Task;
          break;
        }
      }
    }

    if (!firstTask) return;

    const required = getX402PaymentRequirements(firstTask);
    if (!required) return;

    if (this._x402.onPaymentRequired) {
      await this._x402.onPaymentRequired(required);
    }

    const signed = await this._signX402(firstTask);

    const followup: SendMessageParams = {
      ...params,
      message: {
        ...params.message,
        messageId: globalThis.crypto.randomUUID(),
        taskId: firstTask.id,
        contextId: firstTask.contextId,
        metadata: {
          ...(params.message.metadata ?? {}),
          ...signed.metadata,
        },
      },
    };

    yield* this._sendMessageStreamOnce(followup, signal);
  }

  private async _sendMessageOnce(params: SendMessageParams): Promise<Task> {
    await this._ensureResolved();
    await this._ensureAuthenticated();
    const formatted = this._formatParams(params);
    const request = this._buildJsonRpcRequest(A2A_METHODS.SEND_MESSAGE, formatted);
    const result = await this._postJsonRpc(request);
    const task = this._parser!.parseTask(result);
    // Spec a2a-v0.3 §TaskState / a2a-v1.0 §TASK_STATE_AUTH_REQUIRED:
    // an auth failure surfaces as a Task in `auth-required` state.
    // Refresh credentials once and retry; the same condition on the
    // second response is propagated to the caller as-is.
    if (task.status.state !== TaskState.AUTH_REQUIRED) return task;
    if (!(await this._refreshAuth())) return task;
    const retryRequest = this._buildJsonRpcRequest(A2A_METHODS.SEND_MESSAGE, formatted);
    const retryResult = await this._postJsonRpc(retryRequest);
    return this._parser!.parseTask(retryResult);
  }

  private async *_sendMessageStreamOnce(
    params: SendMessageParams,
    signal?: AbortSignal,
  ): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    await this._ensureResolved();
    await this._ensureAuthenticated();
    yield* this._streamWithAuthRetry(params, signal, false);
  }

  private async *_streamWithAuthRetry(
    params: SendMessageParams,
    signal: AbortSignal | undefined,
    isRetry: boolean,
  ): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    const formatted = this._formatParams(params);
    const request = this._buildJsonRpcRequest(
      A2A_METHODS.STREAM_MESSAGE,
      formatted,
    );

    const headers = this._buildHeaders({
      Accept: 'text/event-stream',
    });
    const url = new URL(this._endpointUrl!);

    this._applyAuth({ headers, url });

    const response = await this._fetchImpl(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
      signal,
    });

    if (!response.ok) {
      throw new InternalError(
        `HTTP ${response.status}: ${response.statusText}`,
      );
    }

    // Server may return a JSON-RPC error instead of SSE
    // (e.g., unsupported operation, invalid params).
    const contentType = response.headers.get('content-type') ?? '';
    if (!contentType.includes('text/event-stream')) {
      const jsonRpcResponse = (await response.json()) as JSONRPCResponse;
      if ('error' in jsonRpcResponse && jsonRpcResponse.error) {
        const { code, message, data } = jsonRpcResponse.error;
        const ErrorClass = ERROR_CODE_MAP[code] ?? InternalError;
        throw new ErrorClass(message, data);
      }
      return;
    }

    // Buffer the first event so we can inspect for auth-required without
    // surfacing it to the caller before deciding to refresh+retry.
    const events = parseSSEStream(response, this._parser!);
    const firstResult = await events.next();
    if (firstResult.done) return;
    const firstEvent = firstResult.value;
    if (
      !isRetry &&
      'status' in firstEvent &&
      firstEvent.status?.state === TaskState.AUTH_REQUIRED &&
      (await this._refreshAuth())
    ) {
      yield* this._streamWithAuthRetry(params, signal, true);
      return;
    }
    yield firstEvent;
    yield* events;
  }

  private async _signX402(task: Task): Promise<SignedX402Payment> {
    const x402 = this._x402!;
    const userSelect = x402.selectRequirement;
    const select = (
      reqs: X402PaymentRequirements[],
    ): X402PaymentRequirements | undefined => {
      // maxAmount is enforced first regardless of caller predicate, so a
      // user-provided selectRequirement only sees the affordable subset.
      const affordable =
        x402.maxAmount === undefined
          ? reqs
          : reqs.filter((r) => isWithinBudget(r, x402.maxAmount!));
      if (userSelect) return userSelect(affordable);
      return affordable.find((r) => r.scheme === 'exact') ?? affordable[0];
    };
    return signX402Payment(task, {
      signer: x402.signer,
      selectRequirement: select,
    });
  }

  /**
   * Retrieve the current state of a task.
   * Uses JSON-RPC method `tasks/get`.
   *
   * Spec a2a-v0.3 §TaskQueryParams: pass `historyLength` to bound the
   * size of the `history` slice the server returns. Useful for polling
   * long-running conversations without pulling the whole transcript.
   */
  async getTask(
    taskId: string,
    options?: { historyLength?: number; metadata?: Record<string, unknown> },
  ): Promise<Task> {
    await this._ensureResolved();
    await this._ensureAuthenticated();
    const params: Record<string, unknown> = { id: taskId };
    if (options?.historyLength !== undefined) {
      params.historyLength = options.historyLength;
    }
    if (options?.metadata !== undefined) {
      params.metadata = options.metadata;
    }
    const request = this._buildJsonRpcRequest(A2A_METHODS.GET_TASK, params);
    const result = await this._postJsonRpc(request);
    return this._parser!.parseTask(result);
  }

  /**
   * Request cancellation of a task.
   * Uses JSON-RPC method `tasks/cancel`.
   */
  async cancelTask(taskId: string): Promise<Task> {
    await this._ensureResolved();
    await this._ensureAuthenticated();
    const request = this._buildJsonRpcRequest(A2A_METHODS.CANCEL_TASK, {
      id: taskId,
    });
    const result = await this._postJsonRpc(request);
    return this._parser!.parseTask(result);
  }

  /**
   * Get the resolved AgentCard. Fetches from the server if not already cached.
   */
  async getAgentCard(): Promise<AgentCardV03 | AgentCardV10> {
    await this._ensureResolved();
    return this._resolved!.card;
  }

  // ─── Private Methods ───

  /**
   * Resolve security requirements from the agent card and call AuthProvider.
   *
   * SDK handles: requirement normalization, scheme class construction,
   * OR-of-ANDs structure, OAuth2 flow expansion.
   * Client handles: credential acquisition via provide() callback.
   */
  private async _ensureAuthenticated(): Promise<void> {
    if (this._resolvedSchemes) return;
    if (!this._authProvider) return;

    const card = this._resolved!.card;
    const rawCard = card as unknown as Record<string, unknown>;

    // v0.3 uses "security", v1.0 uses "securityRequirements"
    const rawRequirementsField =
      (rawCard.security as unknown[] | undefined) ??
      (rawCard.securityRequirements as unknown[] | undefined) ??
      [];
    if (rawRequirementsField.length === 0) return;

    // Normalize v1.0 wrapped format { schemes: { name: { values: [...] } } }
    // to internal flat format { name: [...] }
    const rawRequirements = rawRequirementsField.map((req) => {
      const r = req as Record<string, unknown>;
      if (r.schemes && typeof r.schemes === 'object') {
        // v1.0 format
        const flat: Record<string, string[]> = {};
        for (const [name, val] of Object.entries(r.schemes as Record<string, unknown>)) {
          const v = val as { values?: string[] };
          flat[name] = v.values ?? [];
        }
        return flat;
      }
      // v0.3 format (already flat)
      return r as Record<string, string[]>;
    });

    const rawSchemes =
      (rawCard.securitySchemes as Record<string, unknown> | undefined) ?? {};

    const requirements = normalizeRequirements(
      rawRequirements,
      rawSchemes as Parameters<typeof normalizeRequirements>[1],
    );
    if (requirements.length === 0) return;

    this._resolvedSchemes = await this._authProvider.provide(requirements);
  }

  /**
   * Apply resolved auth schemes to the request context.
   */
  private _applyAuth(ctx: AuthRequestContext): void {
    if (!this._resolvedSchemes) return;
    for (const scheme of this._resolvedSchemes) {
      scheme.applyToRequest(ctx);
    }
  }

  private async _ensureResolved(): Promise<void> {
    if (this._resolved) return;

    if (typeof this._urlOrCard === 'string') {
      this._resolved = await resolveAgentCard(this._urlOrCard, {
        fetch: this._fetchImpl,
        headers: this._headers,
      });
    } else {
      // AgentCard object provided directly
      const card = this._urlOrCard;
      const version = detectProtocolVersion(
        card as unknown as Record<string, unknown>,
      );
      const endpointUrl = getAgentEndpointUrl(card, version);

      this._resolved = {
        card,
        version,
        baseUrl: new URL(endpointUrl).origin,
      };
    }

    this._parser = getResponseParser(this._resolved!.version);
    this._endpointUrl = getAgentEndpointUrl(
      this._resolved!.card,
      this._resolved.version,
    );
  }

  /**
   * Format SendMessageParams for the target protocol version.
   * v0.3 servers expect `kind` discriminators and different field structures.
   */
  private _formatParams(params: SendMessageParams): unknown {
    if (this._resolved?.version !== '0.3') return params;

    // Deep clone to avoid mutating the original
    const formatted = JSON.parse(JSON.stringify(params)) as Record<string, unknown>;

    // Format message
    const message = formatted.message as Record<string, unknown> | undefined;
    if (message) {
      if (!message.kind) message.kind = 'message';
      const parts = message.parts as Array<Record<string, unknown>> | undefined;
      if (parts) {
        message.parts = parts.map(formatPartToV03);
      }
    }

    // configuration is now spec-shaped on the public API surface
    // (`blocking`, `pushNotificationConfig`, …) — passthrough.
    return formatted;
  }

  private _buildHeaders(
    extra?: Record<string, string>,
  ): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra,
      ...this._headers,
    };
    if (this._extensions.size > 0) {
      // Spec a2a-x402 v0.2 §8: clients MUST request activation via
      // `X-A2A-Extensions`. Multiple active extensions are comma-separated
      // per standard HTTP list-header convention.
      headers['X-A2A-Extensions'] = [...this._extensions].join(', ');
    }
    return headers;
  }

  private _buildJsonRpcRequest(
    method: string,
    params: unknown,
  ): JSONRPCRequest {
    return {
      jsonrpc: '2.0',
      id: ++this._requestId,
      method,
      params,
    };
  }

  private async _postJsonRpc(request: JSONRPCRequest): Promise<unknown> {
    const headers = this._buildHeaders();
    const url = new URL(this._endpointUrl!);

    this._applyAuth({ headers, url });

    const response = await this._fetchImpl(url.toString(), {
      method: 'POST',
      headers,
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      throw new InternalError(
        `HTTP ${response.status}: ${response.statusText}`,
      );
    }

    const jsonRpcResponse = (await response.json()) as JSONRPCResponse;

    if ('error' in jsonRpcResponse && jsonRpcResponse.error) {
      const { code, message, data } = jsonRpcResponse.error;
      const ErrorClass = ERROR_CODE_MAP[code] ?? InternalError;
      throw new ErrorClass(message, data);
    }

    return (jsonRpcResponse as { result: unknown }).result;
  }

  /**
   * Per A2A spec, an auth failure on a task-creating call surfaces as a
   * Task in `auth-required` state — not as a transport error and not as a
   * JSON-RPC error code. When the AuthProvider supports `refresh()`, the
   * client refreshes credentials once and retries the same call.
   */
  private async _refreshAuth(): Promise<boolean> {
    if (!this._authProvider?.refresh || !this._resolvedSchemes) return false;
    this._resolvedSchemes = await this._authProvider.refresh(
      this._resolvedSchemes,
    );
    return true;
  }
}

function isWithinBudget(
  requirement: X402PaymentRequirements,
  maxAmount: bigint,
): boolean {
  try {
    return BigInt(requirement.maxAmountRequired) <= maxAmount;
  } catch {
    // Unparseable amount — defer to the signer to fail loudly rather
    // than silently swallow the requirement.
    return true;
  }
}
