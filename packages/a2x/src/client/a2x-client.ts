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
  VersionNotSupportedError,
  A2A_ERROR_CODES,
} from '../types/errors.js';
import { TaskState, TERMINAL_STATES } from '../types/task.js';
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
  X402_FOUNDATION_EXTENSION_URI,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
} from '../x402/constants.js';
import { detectX402Version, requirementAmount } from '../x402/versions.js';
import {
  defaultSelect,
  signX402Payment,
  rejectX402Payment,
  reconcileX402BatchSettlement,
  getX402BatchSettlementBinding,
  getX402PaymentRequirements,
  getX402Receipts,
  type SignedX402Payment,
  type X402BatchSettlementBinding,
  type X402BatchSettlementOptions,
  type X402ClientChannelStorage,
} from '../x402/client.js';
import {
  X402PaymentFailedError,
  X402PaymentRequiredError,
  X402ReconciliationError,
} from '../x402/errors.js';
import type {
  X402PaymentRequirements,
  X402PaymentRequiredResponse,
  X402SettleResponse,
} from '../x402/types.js';

// ─── Types ───

/**
 * a2a-x402 client options. When supplied to `A2XClientOptions.x402`,
 * `A2XClient` transparently runs the Standalone Flow: when the agent
 * returns `payment-required`, the client signs one of the merchant's
 * `accepts[]` requirements and resubmits with the signed payload, then
 * surfaces only the final task to the caller.
 *
 * The client signs whichever version the agent emits — see
 * `specification/x402-transport-a2a-v1.md` and `-v2.md`.
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
   *
   * For `batch-settlement` the cap applies to the **deposit**, not just the
   * request amount: paying one call there authorizes `depositMultiplier x`
   * the price (5x by default), and a cap that only bounded the per-call
   * amount would let a wallet capped at 1 USDC authorize 5. The request amount
   * is filtered before selection like every other scheme; after the scheme
   * reads channel storage, any deposit it actually sizes (including one a
   * `depositStrategy` returned) is checked again before signing. A funded
   * channel that needs only a voucher therefore remains payable, while a new
   * deposit above the cap throws rather than silently authorizing.
   */
  maxAmount?: bigint;
  /**
   * Custom predicate to pick a requirement out of the merchant's
   * `accepts[]` (already filtered by `maxAmount` if set). Default: the first
   * EVM `scheme === 'exact'` option (see `allowUpto`).
   */
  selectRequirement?: (
    requirements: X402PaymentRequirements[],
  ) => X402PaymentRequirements | undefined;
  /**
   * Let the default selector fall back to a CAIP-2 EVM `upto` (usage-based)
   * offer when the merchant advertises no affordable `exact` one — `upto` is
   * an x402 V2 scheme, so V1 (bare-name) offers are never eligible.
   * Default `false`.
   *
   * Opt-in because an `upto` signature authorizes the merchant to draw
   * anything up to `amount`, not that exact amount — a broader consent than
   * the wallet gave by setting `maxAmount`. `maxAmount` still applies (it
   * bounds the authorized maximum), and a payable `exact` offer always wins.
   *
   * Ignored when `selectRequirement` is supplied.
   */
  allowUpto?: boolean;
  /**
   * Channel storage and deposit policy for the `batch-settlement` scheme,
   * which pays out of a pre-funded on-chain channel instead of settling each
   * call. Supplying it registers the scheme (it cannot be constructed from a
   * signer alone) and makes the client reconcile each task's receipts back
   * into `storage` — the step that advances the payer's cumulative voucher.
   * Complete batch attempts sharing one storage object are serialized in this
   * process so concurrent calls cannot sign from the same pre-payment state.
   *
   * See `X402BatchSettlementOptions`: `storage` must be durable.
   */
  batchSettlement?: X402BatchSettlementOptions;
  /**
   * Let the default selector fall back to a CAIP-2 EVM `batch-settlement`
   * offer when the merchant advertises no affordable `exact` or (under
   * `allowUpto`) `upto` one. Default `false`, and ignored unless
   * `batchSettlement` is configured.
   *
   * Its own flag rather than part of `allowUpto` because funding a channel is
   * a prepayment made before any service is rendered, not a wider draw on an
   * authorization. `maxAmount` bounds the **deposit** here, not just the
   * per-request amount — see its own docs.
   *
   * Ignored when `selectRequirement` is supplied.
   */
  allowBatchSettlement?: boolean;
  /**
   * Called instead of throwing from the attempt whose settled
   * `batch-settlement` receipt could not be folded back into channel storage.
   * Concurrent attempts already queued on the same storage object are still
   * rejected with that error before signing; absorbing the originating error
   * cannot make their stale storage snapshot safe to use.
   *
   * Without a handler the SDK throws `X402ReconciliationError`, which carries
   * the merchant's terminal task when one arrived. A transport, parsing, or
   * premature stream-end failure instead uses `reason: 'ambiguous-response'`:
   * the merchant may hold the voucher even though no task came back. That
   * default is deliberate: a lost receipt leaves the channel desynced with no
   * self-heal path, so the next call is rejected for a cumulative mismatch or
   * opens a **fresh on-chain deposit**, and an operator who is never told
   * cannot quarantine the channel first.
   *
   * Supply this to record the failure and continue — e.g. page an operator and
   * mark the channel unusable — rather than surfacing it to the caller.
   */
  onReconcileError?: (
    error: X402ReconciliationError,
  ) => void | Promise<void>;
  /**
   * Hook invoked after the merchant publishes `payment-required` and
   * before the client signs. Useful for prompting the user to confirm,
   * declining the challenge, or recording the prompt for audit.
   *
   * Return value semantics:
   *  - `void` / `undefined` / `true` — proceed: sign and resubmit (default).
   *  - `false` — decline: send `x402.payment.status: payment-rejected`
   *    on the same task per a2a-x402 v0.2 §5.4.2 / §7.1, then return
   *    the merchant's terminal task to the caller. The merchant sees the
   *    decline; the caller does not have to construct the rejection
   *    message itself.
   *
   * Throw to abort *locally* without telling the merchant — the caller
   * observes the unmodified `payment-required` task (blocking) or a
   * stream that closes after the `payment-required` event (streaming).
   * Use `false` instead when you want the merchant's task to terminate
   * cleanly rather than be left stranded in `input-required`.
   */
  onPaymentRequired?: (
    required: X402PaymentRequiredResponse,
  ) => void | boolean | Promise<void | boolean>;
  /**
   * Maximum number of *additional* sign+resubmit attempts after the
   * first one when the merchant runs `retryOnFailure: true` and re-issues
   * `payment-required` on the same task (a2a-x402 v0.2 §9; see also the
   * server-side `retryOnFailure` in `X402PaymentExecutor`).
   *
   * Default `0` — the SDK signs once and surfaces whatever comes back.
   * Set to `1` or more to opt into automatic retries; the dance bails
   * out when the merchant returns a terminal state (`completed` /
   * `failed`) or when the budget is exhausted (in which case the most
   * recent retry-required task is returned to the caller).
   *
   * Each retry signs a fresh authorization with a fresh nonce, so this
   * is the right knob for failures the wallet can recover from on its
   * own (network blip, transient nonce reuse) — anything that needs
   * user interaction (top-up, wallet switch) should still surface.
   * A `batch-settlement` attempt is never retried after its matching success
   * receipt has been applied, even if that response also asks for payment
   * again. A status marker without a complete payment-required envelope is
   * ambiguous and quarantines the outstanding channel instead of clearing it.
   */
  maxRetries?: number;
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
   * Enables transparent a2a-x402 payment handling. Omit when calling
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
  [A2A_ERROR_CODES.VERSION_NOT_SUPPORTED]: VersionNotSupportedError,
};

interface ActiveX402BatchAttempt {
  binding: X402BatchSettlementBinding;
  storage: X402ClientChannelStorage;
  quarantineError?: X402ReconciliationError;
  release(): void;
}

interface SignedX402Attempt {
  payment: SignedX402Payment;
  batch?: ActiveX402BatchAttempt;
}

// The peer does not persist provisional state while it signs, so two payloads
// produced from the same storage snapshot can each carry a fresh deposit. The
// channel id is only available after that unsafe signing step; serialize by
// storage identity instead, from before signing until receipt reconciliation
// or quarantine completes. Module scope makes the guard span A2XClient
// instances that share the same storage object.
const _batchAttemptQueues = new WeakMap<
  X402ClientChannelStorage,
  Promise<X402ReconciliationError | undefined>
>();

async function acquireBatchAttemptLock(
  storage: X402ClientChannelStorage,
): Promise<(error?: X402ReconciliationError) => void> {
  if (
    typeof storage !== 'object' ||
    storage === null ||
    typeof (storage as { get?: unknown }).get !== 'function' ||
    typeof (storage as { set?: unknown }).set !== 'function' ||
    typeof (storage as { delete?: unknown }).delete !== 'function'
  ) {
    throw new X402PaymentRequiredError(
      'batchSettlement.storage must provide callable get, set, and delete methods; ' +
        'the SDK does not fall back to in-memory channel storage.',
    );
  }

  const previous =
    _batchAttemptQueues.get(storage) ?? Promise.resolve(undefined);
  let unlock!: (error?: X402ReconciliationError) => void;
  const current = new Promise<X402ReconciliationError | undefined>((resolve) => {
    unlock = resolve;
  });
  _batchAttemptQueues.set(storage, current);

  const previousError = await previous;
  if (previousError) {
    // Every waiter registered before the unsafe outcome must observe it
    // instead of signing from the same stale storage snapshot. Passing the
    // error through this queue node also aborts waiters already chained behind
    // this one; a later explicit retry can start after the queue drains and the
    // operator has repaired or retired the channel.
    unlock(previousError);
    if (_batchAttemptQueues.get(storage) === current) {
      _batchAttemptQueues.delete(storage);
    }
    throw previousError;
  }
  let released = false;
  return (error?: X402ReconciliationError) => {
    if (released) return;
    released = true;
    unlock(error);
    if (_batchAttemptQueues.get(storage) === current) {
      _batchAttemptQueues.delete(storage);
    }
  };
}

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
    if (this._x402 && !this._extensions.has(X402_EXTENSION_URI)) {
      // Spec a2a-x402 v0.2 §8: clients MUST activate the extension via
      // `X-A2A-Extensions`. Auto-register so callers don't have to — but only
      // when the caller didn't already register it explicitly, so a deliberate
      // V1-only declaration is not later dropped by the card-based upgrade.
      this._extensions.add(X402_EXTENSION_URI);
      this._x402UriAutoSeeded = true;
    }
  }

  /** True when the constructor seeded the v0.2 URI itself (vs. the caller). */
  private _x402UriAutoSeeded = false;

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
    if (!getX402PaymentRequirements(first)) return first;

    const maxRetries = this._x402.maxRetries ?? 0;
    let task = first;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const required = getX402PaymentRequirements(task);
      if (!required) break;

      const decision = await this._x402.onPaymentRequired?.(required);

      if (decision === false) {
        return this._sendMessageOnce(this._buildRejectFollowup(params, task));
      }

      const signedAttempt = await this._signX402(task);
      const { payment: signed, batch } = signedAttempt;
      try {
        try {
          task = await this._sendMessageOnce(
            this._buildSubmitFollowup(params, task, signed.metadata),
          );
        } catch (cause) {
          // Submission may already have reached the merchant before transport,
          // JSON parsing, or response validation failed. The signed voucher is
          // therefore potentially spendable even though no task came back.
          await this._reconcileX402(undefined, batch, undefined, {
            responseEnded: true,
            cause,
          });
          // A handler may deliberately absorb the quarantine error. Preserve
          // the original request failure in that case.
          throw cause;
        }
        // Per attempt, not once after the loop: under `retryOnFailure` an
        // intermediate attempt can settle before a later one re-prompts, and
        // that receipt is state the payer must record either way. Bound to the
        // channel and storage *this attempt* signed against.
        const reconciled = await this._reconcileX402(
          task.status.message?.metadata,
          batch,
          task,
        );
        const batchAttemptResolved = batch !== undefined && reconciled;

        // Server may re-issue payment-required when running with
        // retryOnFailure (a2a-x402 v0.2 §9). Loop within the budget; once
        // exhausted (or on any non-payment-required terminal), fall through
        // to the receipt-scan decision. A matching batch receipt wins over a
        // contradictory retry prompt: that voucher was accepted and signing
        // again would authorize the same call twice. Non-batch retries retain
        // their existing behavior because they have no binding.
        if (
          !batchAttemptResolved &&
          task.status.state === 'input-required' &&
          getX402PaymentRequirements(task)
        ) {
          continue;
        }
        if (!reconciled) {
          // A non-blocking unary response can legitimately be intermediate, but
          // returning it ends the only exchange that still owns this binding.
          // Without a receipt or explicit retry prompt, the merchant may retain
          // the voucher, so the channel must be quarantined before the binding
          // falls out of scope.
          await this._reconcileX402(undefined, batch, task, {
            responseEnded: true,
          });
        }
        break;
      } finally {
        // The lease starts before signing and spans submission plus every
        // reconcile/quarantine exit, so another call cannot sign from the same
        // pre-payment storage snapshot.
        batch?.release();
      }
    }

    this._throwIfX402Failure(task);
    return task;
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

    let currentParams = params;
    // First sign attempt + N additional retries on `retryOnFailure`
    // re-prompts (a2a-x402 v0.2 §9). Default 0 retries → exactly one
    // sign+resubmit, matching the long-standing client behavior.
    let signsRemaining = (this._x402.maxRetries ?? 0) + 1;
    // The channel this exchange signed a voucher for, or undefined if it never
    // paid with this scheme. Both facts gate reconciliation — see
    // `_reconcileX402` for why an unbound fold is a real attack surface.
    let signedBatchAttempt: ActiveX402BatchAttempt | undefined;

    while (true) {
      let pendingTask: Task | undefined;
      // This belongs to the whole response stream, not one event. A merchant
      // may emit the success receipt and a contradictory retry prompt in two
      // separate events; once the signed voucher is settled, no later event
      // in this response may authorize the same work again.
      let batchAttemptResolved = false;
      try {
        for await (const event of this._sendMessageStreamOnce(
          currentParams,
          signal,
        )) {
          let eventTask: Task | undefined;
          // Reconcile BEFORE the yield, not after. The receipt rides the final
          // status event, and the idiomatic consumer breaks out of its loop on
          // exactly that event — which calls this generator's `return()` at the
          // suspended `yield`, so nothing after it ever runs. Losing the receipt
          // there costs the payer a second real deposit on the next call.
          if ('status' in event) {
            // Reconstruct the task from the event so a failure here still hands
            // the caller the result it paid for on `X402ReconciliationError` —
            // this runs before the yield, so throwing means the consumer never
            // sees the terminal event itself.
            try {
              eventTask = {
                id: event.taskId,
                contextId: event.contextId,
                status: event.status,
              } as Task;
              const attempt = signedBatchAttempt;
              const reconciled = await this._reconcileX402(
                event.status?.message?.metadata as
                  | Record<string, unknown>
                  | undefined,
                attempt,
                eventTask,
              );
              if (reconciled) {
                signedBatchAttempt = undefined;
                attempt?.release();
                if (attempt !== undefined) batchAttemptResolved = true;
              }
            } catch (cause) {
              // Reconciliation already surfaced the unsafe channel. Do not
              // let the generator's close path report it a second time.
              const attempt = signedBatchAttempt;
              signedBatchAttempt = undefined;
              attempt?.release();
              throw cause;
            }
          }

          if (
            !batchAttemptResolved &&
            eventTask?.status.state === 'input-required' &&
            getX402PaymentRequirements(eventTask)
          ) {
            pendingTask = eventTask;
            // A valid retry prompt proves the previous voucher was rejected.
            // Clear before yielding so consumer-driven iterator close cannot
            // mistake this safe exit for an ambiguous response.
            const attempt = signedBatchAttempt;
            signedBatchAttempt = undefined;
            attempt?.release();
          }

          yield event;
          if (pendingTask) break;
        }
      } catch (cause) {
        if (cause instanceof X402ReconciliationError) throw cause;
        const attempt = signedBatchAttempt;
        signedBatchAttempt = undefined;
        try {
          await this._reconcileX402(undefined, attempt, undefined, {
            responseEnded: true,
            cause,
          });
        } finally {
          attempt?.release();
        }
        throw cause;
      } finally {
        // `AsyncGenerator.return()` skips everything after the suspended
        // `yield`, but still runs this block. Keep the binding alive until this
        // point so consumer-driven close is treated like any other ambiguous
        // end to a response.
        const attempt = signedBatchAttempt;
        signedBatchAttempt = undefined;
        try {
          await this._reconcileX402(undefined, attempt, undefined, {
            responseEnded: true,
          });
        } finally {
          attempt?.release();
        }
      }

      if (!pendingTask) return;

      const required = getX402PaymentRequirements(pendingTask);
      if (!required) return;

      const decision = await this._x402.onPaymentRequired?.(required);
      if (decision === false) {
        // Decline cleanly: surface the rejection follow-up's events to
        // the caller (typically a single `failed` + payment-rejected
        // status update from the merchant).
        yield* this._sendMessageStreamOnce(
          this._buildRejectFollowup(params, pendingTask),
          signal,
        );
        return;
      }

      if (signsRemaining <= 0) return;
      signsRemaining -= 1;

      const signedAttempt = await this._signX402(pendingTask);
      const { payment: signed, batch } = signedAttempt;
      // Assigned, never merged: under `retryOnFailure` a later attempt can
      // select a different scheme, and carrying a stale batch binding forward
      // would test that attempt's `exact` receipt against it and report a
      // successful payment as unreconciled. A non-batch payload correctly
      // clears this to `undefined`.
      signedBatchAttempt = batch;
      try {
        currentParams = this._buildSubmitFollowup(
          params,
          pendingTask,
          signed.metadata,
        );
      } catch (cause) {
        signedBatchAttempt = undefined;
        batch?.release();
        throw cause;
      }
    }
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

  /**
   * Construct a follow-up `message/send` payload that resubmits the
   * caller's original message on the same task with the supplied x402
   * metadata block (signed payload or rejection marker).
   */
  private _buildSubmitFollowup(
    original: SendMessageParams,
    task: Task,
    x402Metadata: Record<string, unknown>,
  ): SendMessageParams {
    return {
      ...original,
      message: {
        ...original.message,
        messageId: globalThis.crypto.randomUUID(),
        taskId: task.id,
        contextId: task.contextId,
        metadata: {
          ...(original.message.metadata ?? {}),
          ...x402Metadata,
        },
      },
    };
  }

  private _buildRejectFollowup(
    original: SendMessageParams,
    task: Task,
  ): SendMessageParams {
    return this._buildSubmitFollowup(original, task, rejectX402Payment(task).metadata);
  }

  /**
   * Decide on the *latest* receipt + final task state, not "any historical
   * failure". The receipts array is the complete history per spec §7, so
   * a successful retry on a task that previously failed must still be
   * surfaced as success (issue #143). Conversely, a task that ends in
   * `failed` with the most recent receipt unsuccessful is a terminal
   * payment failure and should throw.
   */
  private _throwIfX402Failure(task: Task): void {
    if (task.status.state !== 'failed') return;
    const receipts = getX402Receipts(task);
    const latest = receipts[receipts.length - 1];
    if (!latest || latest.success) return;
    const errorCode =
      ((task.status.message?.metadata as Record<string, unknown> | undefined)?.[
        X402_METADATA_KEYS.ERROR
      ] as string | undefined) ?? 'UNKNOWN';
    throw new X402PaymentFailedError(
      latest.errorReason ?? 'Payment failed',
      errorCode,
      { transaction: latest.transaction, network: latest.network },
    );
  }

  private async _signX402(task: Task): Promise<SignedX402Attempt> {
    // Snapshot the mutable caller-owned configuration once for this attempt.
    // In particular, the storage that signing reads must be the same object
    // reconciliation later writes even if the caller swaps options while the
    // network request is in flight.
    const configured = this._x402!;
    const x402: A2XClientX402Options = {
      ...configured,
      ...(configured.batchSettlement !== undefined
        ? { batchSettlement: { ...configured.batchSettlement } }
        : {}),
    };
    const userSelect = x402.selectRequirement;
    const select = (
      reqs: X402PaymentRequirements[],
    ): X402PaymentRequirements | undefined => {
      // maxAmount is enforced first regardless of caller predicate, so a
      // user-provided selectRequirement only sees the affordable subset.
      const usable = reqs.filter((r) => hasUsableBatchDepositPolicy(r, x402));
      const affordable =
        x402.maxAmount === undefined
          ? usable
          : usable.filter((r) => isWithinBudget(r, x402.maxAmount!));
      if (userSelect) return userSelect(affordable);
      // Only auto-pick an option the EVM signer can fulfil, exact-first and
      // never `upto` / `batch-settlement` unless opted in — see defaultSelect
      // in x402/client.ts for the safety rationale. undefined surfaces as
      // X402NoSupportedRequirementError.
      return defaultSelect(affordable, {
        allowUpto: x402.allowUpto,
        allowBatchSettlement:
          x402.allowBatchSettlement && x402.batchSettlement !== undefined,
      });
    };
    const required = getX402PaymentRequirements(task);
    const selected =
      required && detectX402Version(required)
        ? select(required.accepts as X402PaymentRequirements[])
        : undefined;
    const batchSettlement = x402.batchSettlement;
    const release =
      selected?.scheme === 'batch-settlement' && batchSettlement !== undefined
        ? await acquireBatchAttemptLock(batchSettlement.storage)
        : undefined;

    try {
      const payment = await signX402Payment(task, {
        signer: x402.signer,
        // Selection already ran before the batch lease was acquired. Reusing
        // that exact result avoids invoking a stateful caller predicate twice.
        selectRequirement: () => selected,
        ...(batchSettlement !== undefined
          ? { batchSettlement: this._cappedBatchSettlement(x402) }
          : {}),
      });
      if (!release || !batchSettlement) return { payment };

      const binding = getX402BatchSettlementBinding(payment.payload);
      if (!binding) {
        throw new X402PaymentRequiredError(
          'The selected batch-settlement signer returned a payload without a usable channel binding.',
        );
      }
      const batch: ActiveX402BatchAttempt = {
        binding,
        storage: batchSettlement.storage,
        release: () => release(batch.quarantineError),
      };
      return {
        payment,
        batch,
      };
    } catch (cause) {
      release?.();
      throw cause;
    }
  }

  /**
   * `batchSettlement` with `maxAmount` enforced at the point the deposit is
   * actually sized.
   *
   * Only the scheme knows whether this request needs a deposit: it must derive
   * the channel id and read storage first. A static `depositMultiplier x
   * amount` filter would reject a funded channel even though the scheme emits
   * only a voucher there. The cap therefore lives at this sizing hook, which
   * runs only when the channel needs initial funding or a top-up.
   *
   * The guard wraps whatever strategy the caller supplied (or stands in for
   * one when they supplied none, which is where the peer's own
   * policy-computed amount lands) and refuses anything over the cap. It
   * preserves the strategy protocol exactly: `false` still skips the deposit,
   * and `undefined` still means "use the policy amount" — that value is
   * validated too, since it is the one that would be signed.
   */
  private _cappedBatchSettlement(
    x402: A2XClientX402Options,
  ): X402BatchSettlementOptions {
    const batchSettlement = x402.batchSettlement!;
    const maxAmount = x402.maxAmount;
    if (maxAmount === undefined) return batchSettlement;
    const inner = batchSettlement.depositStrategy;
    return {
      ...batchSettlement,
      depositStrategy: async (context) => {
        const result = inner ? await inner(context) : undefined;
        if (result === false) return false;
        const amount = result === undefined ? context.depositAmount : result;
        let value: bigint;
        try {
          value = BigInt(amount);
        } catch {
          throw new X402PaymentRequiredError(
            `Deposit amount "${String(amount)}" is not an integer; cannot check it against maxAmount.`,
          );
        }
        if (value > maxAmount) {
          throw new X402PaymentRequiredError(
            `batch-settlement deposit of ${value} exceeds maxAmount ${maxAmount}. ` +
              'Funding a channel authorizes the whole deposit up front, not just this call — ' +
              'raise maxAmount or lower depositPolicy.depositMultiplier / depositStrategy.',
          );
        }
        return result;
      },
    };
  }

  /**
   * Fold receipts back into `batch-settlement` channel storage, because a2x
   * never executes `@x402/evm`'s own `onPaymentResponse` hook — see
   * `reconcileX402BatchSettlement`.
   *
   * **Only ever called for an exchange this client paid with a voucher.** The
   * storage key is the merchant-supplied `channelState.channelId`, and channel
   * ids are derived from public inputs, so any agent could compute the one
   * this payer shares with a *different* merchant. Folding receipts from every
   * response would let an agent this payer merely messaged plant a bogus
   * cumulative for someone else's channel — bricking it (a mismatched
   * cumulative is rejected forever, see below) or forcing an inflated voucher
   * and top-up. Gating on "we actually paid, with this scheme" keeps the trust
   * boundary at the merchant the payer chose to transact with.
   *
   * The fold is additionally bound to `channelId` — the channel *this attempt
   * signed a voucher for*. The gate above only establishes that the payer
   * chose to pay this merchant; it does not stop that merchant from naming
   * someone else's channel in its receipt, which is equally computable from
   * public inputs. Binding per attempt leaves a merchant able to update only
   * the channel it was actually paid through.
   *
   * Failure is **not** swallowed. The server requires the next voucher's
   * cumulative to equal exactly `charged + amount`, and `@x402/evm`'s self-heal
   * path needs a signer with `readContract`, which a viem `LocalAccount` does
   * not have — so a missed receipt leaves the channel desynced until its
   * storage is repaired out of band, and the next call can sign a fresh real
   * deposit. An operator who never hears about it cannot stop that. The error
   * carries the completed task so the caller keeps its result either way; pass
   * `onReconcileError` to handle it without throwing.
   */
  private async _reconcileX402(
    metadata: Record<string, unknown> | undefined,
    attempt: ActiveX402BatchAttempt | undefined,
    task: Task | undefined,
    options: { responseEnded?: boolean; cause?: unknown } = {},
  ): Promise<boolean> {
    if (!attempt) return true;
    const { binding, storage } = attempt;

    // Only a settled payment owes us a receipt. Intermediate events
    // (`payment-verified`, plain `working`) legitimately carry none. Once the
    // merchant completes the A2A task after receiving our voucher, however,
    // the voucher must be treated as spent even if the remote peer omits the
    // x402 status marker. Otherwise it can suppress both marker and receipt,
    // leave local state stale, and make the next call re-sign or re-deposit.
    const receiptRequired =
      metadata?.[X402_METADATA_KEYS.STATUS] === X402_PAYMENT_STATUS.COMPLETED ||
      (task !== undefined && TERMINAL_STATES.has(task.status.state)) ||
      options.responseEnded === true;
    const receipts = metadata?.[X402_METADATA_KEYS.RECEIPTS];
    const list = Array.isArray(receipts)
      ? (receipts as X402SettleResponse[])
      : [];
    if (!receiptRequired && list.length === 0) return false;

    let applied: string[] = [];
    let cause: unknown;
    try {
      ({ applied } = await reconcileX402BatchSettlement(list, {
        storage,
        bindings: binding,
      }));
    } catch (err) {
      cause = err;
    }

    // Nothing written on a settled payment is a failure, not a no-op: the
    // voucher is spent and local state did not move, so the next call either
    // re-signs the same voucher or opens a fresh on-chain deposit. This is the
    // case where the merchant returned no receipt, a foreign channel, or a
    // cumulative above what we authorized — silence there is exactly what the
    // error exists to prevent.
    if (cause === undefined && applied.length > 0) return true;
    if (cause === undefined && !receiptRequired) return false;

    const reason = options.responseEnded
      ? 'ambiguous-response'
      : cause === undefined
        ? 'no-matching-receipt'
        : 'write-failed';

    const error = new X402ReconciliationError(binding.channelId, task, {
      cause: cause ?? options.cause,
      reason,
    });
    // Releasing the full-attempt lease must carry this unsafe outcome to calls
    // that are already queued on the same storage object. Otherwise the next
    // waiter signs from the unchanged snapshot and can authorize a duplicate
    // deposit before the operator has a chance to quarantine the channel.
    attempt.quarantineError = error;
    const handler = this._x402?.onReconcileError;
    if (!handler) throw error;
    await handler(error);
    return true;
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
    this._activateX402Extension();
  }

  /**
   * Pick the x402 URI to activate from the resolved AgentCard. The
   * constructor seeds the legacy v0.2 URI as a backward-compatible baseline;
   * if the card advertises the foundation URI, upgrade to it. Signing
   * dispatches on the version of the envelope actually received, so the
   * activated URI never constrains what this client can decode.
   */
  private _activateX402Extension(): void {
    if (!this._x402) return;
    // A caller-registered v0.2 URI is an explicit "this client decodes V1
    // only" declaration, so leave the activation set untouched. A V1 server
    // serves it; a V2 server fails it fast with `invalid_x402_version`
    // instead of emitting envelopes the caller said it cannot parse.
    // Sending the v0.2 URI alone (not alongside the foundation URI) is what
    // keeps the declaration legible to any peer. The x402 activation family
    // means it still satisfies an agent that requires the foundation URI.
    if (!this._x402UriAutoSeeded) return;
    const card = this._resolved?.card as
      | { capabilities?: { extensions?: Array<{ uri?: string }> } }
      | undefined;
    const advertised = new Set(
      (card?.capabilities?.extensions ?? [])
        .map((e) => e.uri)
        .filter((u): u is string => typeof u === 'string'),
    );
    if (advertised.has(X402_FOUNDATION_EXTENSION_URI)) {
      this._extensions.add(X402_FOUNDATION_EXTENSION_URI);
      this._extensions.delete(X402_EXTENSION_URI);
    }
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

/** Lowest multiplier `@x402/evm`'s `validateDepositPolicy` accepts. */
const MIN_DEPOSIT_MULTIPLIER = 3;

/**
 * True when a `batch-settlement` requirement can be constructed with the
 * configured deposit policy. Every other scheme passes through.
 *
 * The peer validates this during scheme construction regardless of whether
 * the current channel needs a deposit. Filtering the unusable option here
 * preserves the clean `X402NoSupportedRequirementError` instead of leaking a
 * generic constructor error. Deposit affordability is deliberately not
 * predicted here: only the scheme can know, after reading storage, whether it
 * will fund the channel or emit a voucher-only payload.
 */
function hasUsableBatchDepositPolicy(
  requirement: X402PaymentRequirements,
  x402: A2XClientX402Options,
): boolean {
  if (requirement.scheme !== 'batch-settlement') return true;
  const batchSettlement = x402.batchSettlement;
  if (!batchSettlement) return true;

  const configured = batchSettlement.depositPolicy?.depositMultiplier;
  return (
    configured === undefined ||
    (Number.isInteger(configured) && configured >= MIN_DEPOSIT_MULTIPLIER)
  );
}

function isWithinBudget(
  requirement: X402PaymentRequirements,
  maxAmount: bigint,
): boolean {
  try {
    // Read through the version-agnostic accessor: V2 requirements carry
    // `amount`, not `maxAmountRequired` — reading the V1 field directly would
    // throw here and the catch below would silently disable the budget cap.
    return BigInt(requirementAmount(requirement)) <= maxAmount;
  } catch {
    // Unparseable amount — defer to the signer to fail loudly rather
    // than silently swallow the requirement.
    return true;
  }
}
