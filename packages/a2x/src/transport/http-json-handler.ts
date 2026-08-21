/** A2A v1.0 HTTP+JSON/REST protocol binding. */

import type { DefaultRequestHandler, OperationResult } from './request-handler.js';
import type { RequestContext } from '../types/auth.js';
import { A2A_METHODS } from '../types/jsonrpc.js';
import type { A2AError } from '../types/errors.js';
import {
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

export const A2A_HTTP_JSON_MEDIA_TYPE = 'application/a2a+json';

export interface HttpJsonRequest {
  method: string;
  url: string | URL;
  body?: unknown;
  context?: RequestContext;
}

export interface HttpJsonResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown | AsyncGenerator<unknown>;
}

export interface HttpJsonRequestHandlerOptions {
  /** Path prefix advertised by the HTTP+JSON AgentInterface. */
  basePath?: string;
}

interface ResolvedRoute {
  operation: string;
  params?: unknown;
  stream?: boolean;
  wrapSendResponse?: boolean;
  emptyResponse?: boolean;
}

export class HttpJsonRequestHandler {
  private readonly basePath: string;

  constructor(
    private readonly handler: DefaultRequestHandler,
    options?: HttpJsonRequestHandlerOptions,
  ) {
    this.basePath = normalizeBasePath(options?.basePath ?? '/');
  }

  canHandle(method: string, url: string | URL): boolean {
    let parsedUrl: URL;
    try {
      parsedUrl = toUrl(url);
    } catch {
      return false;
    }
    try {
      return this._resolve(method, parsedUrl) !== null;
    } catch {
      const rawPath = stripBasePath(parsedUrl.pathname, this.basePath);
      return rawPath !== null && matchesHttpJsonRoute(method, rawPath);
    }
  }

  async handle(request: HttpJsonRequest): Promise<HttpJsonResponse> {
    try {
      const card = this.handler.getAgentCard() as { protocolVersion?: string };
      if (card.protocolVersion?.startsWith('0.3')) {
        throw new VersionNotSupportedError(
          'HTTP+JSON is supported only by A2A v1.0 servers',
        );
      }
      validateHttpJsonContentType(request);
      const url = toUrl(request.url);
      const route = this._resolve(request.method, url, request.body);
      if (!route) throw new MethodNotFoundError('HTTP+JSON route not found');
      const result = await this.handler.handleOperation(
        route.operation,
        route.params,
        request.context,
        route.stream ? { includeInitialTask: true } : undefined,
      );
      const body = route.stream
        ? wrapRestStream(result as AsyncGenerator<unknown>)
        : route.wrapSendResponse
          ? wrapSendResponse(result)
          : route.emptyResponse
            ? {}
            : result;
      return {
        status: 200,
        headers: {
          'Content-Type': route.stream
            ? 'text/event-stream'
            : A2A_HTTP_JSON_MEDIA_TYPE,
          ...(route.stream
            ? { 'Cache-Control': 'no-cache', Connection: 'keep-alive' }
            : {}),
        },
        body,
      };
    } catch (error) {
      return toHttpJsonErrorResponse(error);
    }
  }

  private _resolve(
    method: string,
    url: URL,
    body?: unknown,
  ): ResolvedRoute | null {
    const httpMethod = method.toUpperCase();
    const rawPath = stripBasePath(url.pathname, this.basePath);
    if (rawPath === null) return null;
    const { path, tenant } = splitTenantPath(rawPath);
    const payload = asRecord(body);
    const withTenant = (params: Record<string, unknown>) => ({
      ...params,
      ...(tenant !== undefined ? { tenant } : {}),
    });

    if (httpMethod === 'POST' && path === '/message:send') {
      return {
        operation: A2A_METHODS.SEND_MESSAGE,
        params: withTenant(payload),
        wrapSendResponse: true,
      };
    }
    if (httpMethod === 'POST' && path === '/message:stream') {
      return {
        operation: A2A_METHODS.STREAM_MESSAGE,
        params: withTenant(payload),
        stream: true,
      };
    }
    if (httpMethod === 'GET' && path === '/tasks') {
      return {
        operation: A2A_METHODS.LIST_TASKS,
        params: withTenant(queryParams(url)),
      };
    }
    if (httpMethod === 'GET' && path === '/extendedAgentCard') {
      return {
        operation: A2A_METHODS.GET_EXTENDED_CARD,
        params: withTenant(queryParams(url)),
      };
    }

    let match = /^\/tasks\/([^/]+)$/.exec(path);
    if (httpMethod === 'GET' && match) {
      return {
        operation: A2A_METHODS.GET_TASK,
        params: withTenant({ id: decode(match[1]!), ...queryParams(url) }),
      };
    }

    match = /^\/tasks\/([^/]+):cancel$/.exec(path);
    if (httpMethod === 'POST' && match) {
      return {
        operation: A2A_METHODS.CANCEL_TASK,
        params: withTenant({ ...payload, id: decode(match[1]!) }),
      };
    }

    match = /^\/tasks\/([^/]+):subscribe$/.exec(path);
    // The v1.0 prose binding specifies POST; the vendored proto annotation
    // specifies GET. Accept both so either conforming implementation can
    // interoperate while emitting POST from the first-party client.
    if ((httpMethod === 'POST' || httpMethod === 'GET') && match) {
      return {
        operation: A2A_METHODS.RESUBSCRIBE,
        params: withTenant({
          ...(httpMethod === 'POST' ? payload : queryParams(url)),
          id: decode(match[1]!),
        }),
        stream: true,
      };
    }

    match = /^\/tasks\/([^/]+)\/pushNotificationConfigs$/.exec(path);
    if (match) {
      const taskId = decode(match[1]!);
      if (httpMethod === 'POST') {
        return {
          operation: A2A_METHODS.SET_PUSH_CONFIG,
          params: withTenant({ ...payload, taskId }),
        };
      }
      if (httpMethod === 'GET') {
        return {
          operation: A2A_METHODS.LIST_PUSH_CONFIGS,
          params: withTenant({ taskId, ...queryParams(url) }),
        };
      }
    }

    match = /^\/tasks\/([^/]+)\/pushNotificationConfigs\/([^/]+)$/.exec(path);
    if (match) {
      const params = withTenant({
        ...queryParams(url),
        taskId: decode(match[1]!),
        id: decode(match[2]!),
      });
      if (httpMethod === 'GET') {
        return { operation: A2A_METHODS.GET_PUSH_CONFIG, params };
      }
      if (httpMethod === 'DELETE') {
        return {
          operation: A2A_METHODS.DELETE_PUSH_CONFIG,
          params,
          emptyResponse: true,
        };
      }
    }

    return null;
  }
}

export function validateHttpJsonContentType(request: HttpJsonRequest): void {
  if (request.method.toUpperCase() !== 'POST') return;
  const headers = request.context?.headers ?? {};
  const entry = Object.entries(headers).find(
    ([name]) => name.toLowerCase() === 'content-type',
  )?.[1];
  const value = Array.isArray(entry) ? entry[0] : entry;
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase();
  if (
    mediaType !== A2A_HTTP_JSON_MEDIA_TYPE &&
    mediaType !== 'application/json'
  ) {
    throw new ContentTypeNotSupportedError(
      `HTTP+JSON requests require ${A2A_HTTP_JSON_MEDIA_TYPE} or application/json`,
    );
  }
}

function wrapSendResponse(result: OperationResult): unknown {
  const value = result as Record<string, unknown>;
  if (value && typeof value === 'object' && 'status' in value && 'id' in value) {
    return { task: value };
  }
  return { message: value };
}

async function* wrapRestStream(
  stream: AsyncGenerator<unknown>,
): AsyncGenerator<unknown> {
  try {
    for await (const value of stream) {
      const event = value as Record<string, unknown>;
      if ('artifact' in event) {
        yield { artifactUpdate: event };
      } else if ('taskId' in event && 'status' in event) {
        yield { statusUpdate: event };
      } else if ('id' in event && 'status' in event) {
        yield { task: event };
      } else {
        yield { message: event };
      }
    }
  } catch (error) {
    yield toHttpJsonErrorResponse(error).body;
  }
}

export function toHttpJsonErrorResponse(error: unknown): HttpJsonResponse {
  const mapped = mapError(error);
  return {
    status: mapped.status,
    headers: { 'Content-Type': A2A_HTTP_JSON_MEDIA_TYPE },
    body: {
      error: {
        code: mapped.status,
        status: mapped.statusName,
        message: mapped.error.message,
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: mapped.reason,
            domain: 'a2a-protocol.org',
            ...(mapped.error.data !== undefined
              ? { metadata: { data: JSON.stringify(mapped.error.data) } }
              : {}),
          },
        ],
      },
    },
  };
}

function mapError(error: unknown): {
  error: A2AError;
  status: number;
  statusName: string;
  reason: string;
} {
  const typed = isA2AError(error)
    ? error
    : new InternalError(error instanceof Error ? error.message : 'Internal error');

  if (typed instanceof TaskNotFoundError || typed instanceof MethodNotFoundError) {
    return mapped(typed, 404, 'NOT_FOUND');
  }
  if (typed instanceof InternalError || typed instanceof InvalidAgentResponseError) {
    return mapped(typed, 500, 'INTERNAL');
  }
  if (
    typed instanceof InvalidParamsError ||
    typed instanceof InvalidRequestError ||
    typed instanceof JSONParseError ||
    typed instanceof TaskNotCancelableError ||
    typed instanceof PushNotificationNotSupportedError ||
    typed instanceof UnsupportedOperationError ||
    typed instanceof ContentTypeNotSupportedError ||
    typed instanceof AuthenticatedExtendedCardNotConfiguredError ||
    typed instanceof VersionNotSupportedError
  ) {
    return mapped(typed, 400, 'INVALID_ARGUMENT');
  }
  return mapped(typed, 500, 'INTERNAL');
}

function mapped(
  error: A2AError,
  status: number,
  statusName: string,
) {
  return {
    error,
    status,
    statusName,
    reason:
      error instanceof AuthenticatedExtendedCardNotConfiguredError
        ? 'EXTENDED_AGENT_CARD_NOT_CONFIGURED'
        : error.name
            .replace(/Error$/, '')
            .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
            .replace(/([a-z])([A-Z])/g, '$1_$2')
            .toUpperCase(),
  };
}

function isA2AError(error: unknown): error is A2AError {
  return Boolean(
    error &&
      typeof error === 'object' &&
      'code' in error &&
      'toJSONRPCError' in error,
  );
}

function queryParams(url: URL): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of url.searchParams) {
    if (key === 'pageSize' || key === 'historyLength') {
      result[key] = Number(value);
    } else if (key === 'includeArtifacts') {
      result[key] = value === 'true';
    } else {
      result[key] = value;
    }
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidRequestError('HTTP+JSON request body must be a JSON object');
  }
  return value as Record<string, unknown>;
}

function normalizeBasePath(path: string): string {
  if (!path || path === '/') return '';
  const normalized = path.startsWith('/') ? path : `/${path}`;
  return normalized.replace(/\/+$/, '');
}

function stripBasePath(path: string, basePath: string): string | null {
  if (!basePath) return path || '/';
  if (path === basePath) return '/';
  if (!path.startsWith(`${basePath}/`)) return null;
  return path.slice(basePath.length);
}

function splitTenantPath(path: string): { path: string; tenant?: string } {
  if (
    path === '/message:send' ||
    path === '/message:stream' ||
    path === '/tasks' ||
    path.startsWith('/tasks/') ||
    path === '/extendedAgentCard'
  ) {
    return { path };
  }
  const match = /^\/([^/]+)(\/(?:message:(?:send|stream)|tasks(?:\/.*)?|extendedAgentCard))$/.exec(
    path,
  );
  return match
    ? { tenant: decode(match[1]!), path: match[2]! }
    : { path };
}

function matchesHttpJsonRoute(method: string, rawPath: string): boolean {
  const httpMethod = method.toUpperCase();
  const tenantMatch = /^\/[^/]+(\/.*)$/.exec(rawPath);
  const paths = tenantMatch ? [rawPath, tenantMatch[1]!] : [rawPath];

  return paths.some((path) => {
    if (httpMethod === 'POST') {
      return (
        path === '/message:send' ||
        path === '/message:stream' ||
        /^\/tasks\/[^/]+:(?:cancel|subscribe)$/.test(path) ||
        /^\/tasks\/[^/]+\/pushNotificationConfigs$/.test(path)
      );
    }
    if (httpMethod === 'GET') {
      return (
        path === '/tasks' ||
        path === '/extendedAgentCard' ||
        /^\/tasks\/[^/]+(?::subscribe)?$/.test(path) ||
        /^\/tasks\/[^/]+\/pushNotificationConfigs(?:\/[^/]+)?$/.test(path)
      );
    }
    return (
      httpMethod === 'DELETE' &&
      /^\/tasks\/[^/]+\/pushNotificationConfigs\/[^/]+$/.test(path)
    );
  });
}

function toUrl(value: string | URL): URL {
  return value instanceof URL ? value : new URL(value, 'http://localhost');
}

function decode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new InvalidParamsError('Invalid percent-encoding in resource ID');
  }
}
