/**
 * Transport adapters used by A2XClient.
 *
 * The public client owns discovery, authentication, retries, response
 * normalization, and x402. Adapters own only binding-specific framing.
 */

import type { ProtocolVersion } from './agent-card-resolver.js';
import type { A2ATransport } from '../types/transport.js';
import { A2A_TRANSPORTS } from '../types/transport.js';
import type { JSONRPCRequest, JSONRPCResponse } from '../types/jsonrpc.js';
import { A2A_METHODS, A2A_METHODS_V10 } from '../types/jsonrpc.js';
import type { A2AError } from '../types/errors.js';
import {
  A2A_ERROR_CODES,
  AuthenticatedExtendedCardNotConfiguredError,
  ContentTypeNotSupportedError,
  InternalError,
  InvalidAgentResponseError,
  InvalidParamsError,
  InvalidRequestError,
  JSONParseError,
  MethodNotFoundError,
  PushNotificationNotSupportedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
  VersionNotSupportedError,
} from '../types/errors.js';

export { A2A_TRANSPORTS } from '../types/transport.js';
export type { A2ATransport } from '../types/transport.js';

export interface ClientTransportRequest {
  method: string;
  params?: unknown;
  endpointUrl: string;
  headers: Record<string, string>;
  signal?: AbortSignal;
  onTransport?: () => void | Promise<void>;
}

export interface A2XClientTransport {
  readonly binding: A2ATransport;
  call(request: ClientTransportRequest): Promise<unknown>;
  stream(request: ClientTransportRequest): Promise<Response>;
}

const ERROR_CODE_MAP: Record<
  number,
  new (message?: string, data?: unknown) => A2AError
> = {
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
  [A2A_ERROR_CODES.AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED]:
    AuthenticatedExtendedCardNotConfiguredError,
  [A2A_ERROR_CODES.VERSION_NOT_SUPPORTED]: VersionNotSupportedError,
};

const V10_METHODS = new Map<string, string>(
  (Object.keys(A2A_METHODS) as (keyof typeof A2A_METHODS)[]).map((key) => [
    A2A_METHODS[key],
    A2A_METHODS_V10[key],
  ]),
);

export class JsonRpcClientTransport implements A2XClientTransport {
  readonly binding = A2A_TRANSPORTS.JSONRPC;
  private requestId = 0;

  constructor(
    private readonly fetchImpl: typeof globalThis.fetch,
    private readonly version: ProtocolVersion,
  ) {}

  async call(request: ClientTransportRequest): Promise<unknown> {
    const response = await this._fetch(request, false);
    const jsonRpcResponse = (await response.json()) as JSONRPCResponse;
    if ('error' in jsonRpcResponse && jsonRpcResponse.error) {
      throwA2AError(
        jsonRpcResponse.error.code,
        jsonRpcResponse.error.message,
        jsonRpcResponse.error.data,
      );
    }
    return (jsonRpcResponse as { result: unknown }).result;
  }

  stream(request: ClientTransportRequest): Promise<Response> {
    return this._fetch(request, true);
  }

  private async _fetch(
    request: ClientTransportRequest,
    stream: boolean,
  ): Promise<Response> {
    const method =
      this.version === '1.0'
        ? (V10_METHODS.get(request.method) ?? request.method)
        : request.method;
    const rpc: JSONRPCRequest = {
      jsonrpc: '2.0',
      id: ++this.requestId,
      method,
      ...(request.params !== undefined ? { params: request.params } : {}),
    };
    const body = JSON.stringify(rpc);
    request.signal?.throwIfAborted();
    await request.onTransport?.();
    const response = await this.fetchImpl(request.endpointUrl, {
      method: 'POST',
      headers: {
        ...request.headers,
        ...(stream ? { Accept: 'text/event-stream' } : {}),
      },
      body,
      signal: request.signal,
    });
    if (!response.ok) {
      throw new InternalError(`HTTP ${response.status}: ${response.statusText}`);
    }
    return response;
  }
}

export class HttpJsonClientTransport implements A2XClientTransport {
  readonly binding = A2A_TRANSPORTS.HTTP_JSON;

  constructor(private readonly fetchImpl: typeof globalThis.fetch) {}

  async call(request: ClientTransportRequest): Promise<unknown> {
    const response = await this._fetch(request, false);
    if (!response.ok) await throwHttpJsonError(response);
    if (response.status === 204) return null;
    const value = (await response.json()) as Record<string, unknown>;
    // SendMessageResponse is a oneof wrapper. Other unary operations return
    // their resource directly.
    if (request.method === A2A_METHODS.SEND_MESSAGE) {
      return value.task ?? value.message ?? value;
    }
    return value;
  }

  async stream(request: ClientTransportRequest): Promise<Response> {
    const response = await this._fetch(request, true);
    if (!response.ok) await throwHttpJsonError(response);
    return response;
  }

  private async _fetch(
    request: ClientTransportRequest,
    stream: boolean,
  ): Promise<Response> {
    const target = buildRestRequest(request.endpointUrl, request.method, request.params);
    const body = target.body === undefined ? undefined : JSON.stringify(target.body);
    request.signal?.throwIfAborted();
    await request.onTransport?.();
    const headers: Record<string, string> = {
      ...request.headers,
      Accept: stream ? 'text/event-stream' : 'application/a2a+json',
    };
    if (body === undefined) {
      for (const name of Object.keys(headers)) {
        if (name.toLowerCase() === 'content-type') delete headers[name];
      }
    }
    return this.fetchImpl(target.url, {
      method: target.httpMethod,
      headers,
      ...(body !== undefined ? { body } : {}),
      signal: request.signal,
    });
  }
}

interface RestRequestTarget {
  url: string;
  httpMethod: 'GET' | 'POST' | 'DELETE';
  body?: unknown;
}

function buildRestRequest(
  endpointUrl: string,
  method: string,
  params: unknown,
): RestRequestTarget {
  const p = (params ?? {}) as Record<string, unknown>;
  const tenant =
    typeof p.tenant === 'string' && p.tenant.length > 0
      ? encodeURIComponent(p.tenant)
      : undefined;
  const resourceParams = omitKeys(p, ['tenant']);
  const taskId = encodeURIComponent(String(p.id ?? p.taskId ?? ''));
  const configId = encodeURIComponent(String(p.id ?? ''));
  const route = (suffix: string) =>
    appendRestPath(endpointUrl, `${tenant ? `/${tenant}` : ''}${suffix}`);

  switch (method) {
    case A2A_METHODS.SEND_MESSAGE:
      return {
        url: route('/message:send'),
        httpMethod: 'POST',
        body: resourceParams,
      };
    case A2A_METHODS.STREAM_MESSAGE:
      return {
        url: route('/message:stream'),
        httpMethod: 'POST',
        body: resourceParams,
      };
    case A2A_METHODS.GET_TASK:
      return {
        url: withQuery(route(`/tasks/${taskId}`), omitKeys(resourceParams, ['id'])),
        httpMethod: 'GET',
      };
    case A2A_METHODS.LIST_TASKS:
      return {
        url: withQuery(route('/tasks'), resourceParams),
        httpMethod: 'GET',
      };
    case A2A_METHODS.CANCEL_TASK:
      return {
        url: route(`/tasks/${taskId}:cancel`),
        httpMethod: 'POST',
        body: resourceParams,
      };
    case A2A_METHODS.RESUBSCRIBE:
      // The prose v1.0 binding uses POST while the vendored proto annotation
      // uses GET. Clients follow the published binding; the server accepts both.
      return {
        url: route(`/tasks/${taskId}:subscribe`),
        httpMethod: 'POST',
        body: resourceParams,
      };
    case A2A_METHODS.SET_PUSH_CONFIG:
      return {
        url: route(`/tasks/${encodeURIComponent(String(p.taskId ?? ''))}/pushNotificationConfigs`),
        httpMethod: 'POST',
        body: resourceParams,
      };
    case A2A_METHODS.GET_PUSH_CONFIG:
      return {
        url: withQuery(
          route(`/tasks/${encodeURIComponent(String(p.taskId ?? ''))}/pushNotificationConfigs/${configId}`),
          omitKeys(resourceParams, ['taskId', 'id']),
        ),
        httpMethod: 'GET',
      };
    case A2A_METHODS.LIST_PUSH_CONFIGS:
      return {
        url: withQuery(
          route(`/tasks/${encodeURIComponent(String(p.taskId ?? ''))}/pushNotificationConfigs`),
          omitKeys(resourceParams, ['taskId']),
        ),
        httpMethod: 'GET',
      };
    case A2A_METHODS.DELETE_PUSH_CONFIG:
      return {
        url: withQuery(
          route(`/tasks/${encodeURIComponent(String(p.taskId ?? ''))}/pushNotificationConfigs/${configId}`),
          omitKeys(resourceParams, ['taskId', 'id']),
        ),
        httpMethod: 'DELETE',
      };
    case A2A_METHODS.GET_EXTENDED_CARD:
      return {
        url: withQuery(route('/extendedAgentCard'), resourceParams),
        httpMethod: 'GET',
      };
    default:
      throw new UnsupportedOperationError(`No HTTP+JSON route for '${method}'`);
  }
}

function appendRestPath(endpointUrl: string, suffix: string): string {
  const url = new URL(endpointUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = `${basePath}${suffix}` || '/';
  return url.toString();
}

function withQuery(url: string, values: Record<string, unknown>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue;
    parsed.searchParams.set(key, String(value));
  }
  return parsed.toString();
}

function omitKeys(
  value: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([key]) => !keys.includes(key)));
}

async function throwHttpJsonError(response: Response): Promise<never> {
  let error: Record<string, unknown> = {};
  try {
    const payload = (await response.json()) as { error?: Record<string, unknown> };
    error = payload.error ?? payload;
  } catch {
    // Preserve the HTTP-level error below when the peer did not send JSON.
  }
  const details = Array.isArray(error.details) ? error.details : [];
  const info = details.find(
    (detail) =>
      detail &&
      typeof detail === 'object' &&
      (detail as Record<string, unknown>)['@type'] ===
        'type.googleapis.com/google.rpc.ErrorInfo',
  ) as Record<string, unknown> | undefined;
  const reason = typeof info?.reason === 'string' ? info.reason : undefined;
  const code = REST_REASON_TO_A2A_CODE[reason ?? ''] ?? HTTP_STATUS_TO_A2A_CODE[response.status];
  const message =
    typeof error.message === 'string'
      ? error.message
      : `HTTP ${response.status}: ${response.statusText}`;
  throwA2AError(code ?? A2A_ERROR_CODES.INTERNAL_ERROR, message, details);
}

function throwA2AError(code: number, message: string, data?: unknown): never {
  const ErrorClass = ERROR_CODE_MAP[code] ?? InternalError;
  throw new ErrorClass(message, data);
}

const HTTP_STATUS_TO_A2A_CODE: Record<number, number> = {
  400: A2A_ERROR_CODES.INVALID_REQUEST,
  404: A2A_ERROR_CODES.METHOD_NOT_FOUND,
  413: A2A_ERROR_CODES.INVALID_REQUEST,
  500: A2A_ERROR_CODES.INTERNAL_ERROR,
};

const REST_REASON_TO_A2A_CODE: Record<string, number> = {
  JSON_PARSE: A2A_ERROR_CODES.JSON_PARSE_ERROR,
  INVALID_REQUEST: A2A_ERROR_CODES.INVALID_REQUEST,
  METHOD_NOT_FOUND: A2A_ERROR_CODES.METHOD_NOT_FOUND,
  INVALID_PARAMS: A2A_ERROR_CODES.INVALID_PARAMS,
  INTERNAL: A2A_ERROR_CODES.INTERNAL_ERROR,
  TASK_NOT_FOUND: A2A_ERROR_CODES.TASK_NOT_FOUND,
  TASK_NOT_CANCELABLE: A2A_ERROR_CODES.TASK_NOT_CANCELABLE,
  PUSH_NOTIFICATION_NOT_SUPPORTED: A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED,
  UNSUPPORTED_OPERATION: A2A_ERROR_CODES.UNSUPPORTED_OPERATION,
  CONTENT_TYPE_NOT_SUPPORTED: A2A_ERROR_CODES.CONTENT_TYPE_NOT_SUPPORTED,
  REQUEST_BODY_TOO_LARGE: A2A_ERROR_CODES.INVALID_REQUEST,
  INVALID_AGENT_RESPONSE: A2A_ERROR_CODES.INVALID_AGENT_RESPONSE,
  EXTENDED_AGENT_CARD_NOT_CONFIGURED:
    A2A_ERROR_CODES.AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED,
  AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED:
    A2A_ERROR_CODES.AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED,
  VERSION_NOT_SUPPORTED: A2A_ERROR_CODES.VERSION_NOT_SUPPORTED,
};
