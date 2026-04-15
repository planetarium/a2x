/**
 * A2XClient — Client for communicating with remote A2A agents.
 *
 * Supports both v0.3 and v1.0 protocol versions with auto-detection.
 * Protocol version is determined from the AgentCard structure.
 */

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

// ─── Types ───

export interface A2XClientOptions {
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  /** Authentication provider. Injects credentials into every request. */
  auth?: AuthProvider;
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
  private readonly _auth?: AuthProvider;
  private _resolved: ResolvedAgentCard | null = null;
  private _parser: ResponseParser | null = null;
  private _endpointUrl: string | null = null;
  private _requestId = 0;

  constructor(
    urlOrAgentCard: string | AgentCardV03 | AgentCardV10,
    options?: A2XClientOptions,
  ) {
    this._urlOrCard = urlOrAgentCard;
    this._fetchImpl = options?.fetch ?? globalThis.fetch;
    this._headers = options?.headers ?? {};
    this._auth = options?.auth;
  }

  // ─── Public Methods ───

  /**
   * Send a message and wait for the complete response.
   * Uses JSON-RPC method `message/send`.
   */
  async sendMessage(params: SendMessageParams): Promise<Task> {
    await this._ensureResolved();
    const formatted = this._formatParams(params);
    const request = this._buildJsonRpcRequest(A2A_METHODS.SEND_MESSAGE, formatted);
    const result = await this._postJsonRpc(request);
    return this._parser!.parseTask(result);
  }

  /**
   * Send a message and stream the response via SSE.
   * Uses JSON-RPC method `message/stream`.
   */
  async *sendMessageStream(
    params: SendMessageParams,
    signal?: AbortSignal,
  ): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    await this._ensureResolved();
    const formatted = this._formatParams(params);
    const request = this._buildJsonRpcRequest(
      A2A_METHODS.STREAM_MESSAGE,
      formatted,
    );

    const headers = await this._buildHeaders({
      Accept: 'text/event-stream',
    });

    const response = await this._fetchImpl(this._endpointUrl!, {
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
    // (e.g., authentication failure, unsupported operation).
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

    yield* parseSSEStream(response, this._parser!);
  }

  /**
   * Retrieve the current state of a task.
   * Uses JSON-RPC method `tasks/get`.
   */
  async getTask(taskId: string): Promise<Task> {
    await this._ensureResolved();
    const request = this._buildJsonRpcRequest(A2A_METHODS.GET_TASK, {
      id: taskId,
    });
    const result = await this._postJsonRpc(request);
    return this._parser!.parseTask(result);
  }

  /**
   * Request cancellation of a task.
   * Uses JSON-RPC method `tasks/cancel`.
   */
  async cancelTask(taskId: string): Promise<Task> {
    await this._ensureResolved();
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

    // Format configuration: returnImmediately → blocking (inverted semantics)
    const config = formatted.configuration as Record<string, unknown> | undefined;
    if (config && 'returnImmediately' in config) {
      config.blocking = !config.returnImmediately;
      delete config.returnImmediately;
    }

    return formatted;
  }

  private async _buildHeaders(
    extra?: Record<string, string>,
  ): Promise<Record<string, string>> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...extra,
      ...this._headers,
    };
    if (this._auth) {
      await this._auth.applyAuth(headers);
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
    const headers = await this._buildHeaders();

    const response = await this._fetchImpl(this._endpointUrl!, {
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
}
