/**
 * Layer 4: toA2x helper - quickly converts an LlmAgent to an A2A server.
 */

import type { LlmAgent } from '../agent/llm-agent.js';
import type { BaseSecurityScheme } from '../security/base.js';
import type { A2XAgentSkill } from '../types/agent-card.js';
import type { SecurityRequirement } from '../types/security.js';
import type { ProtocolVersion } from '../a2x/a2x-agent.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryTaskStore } from '../a2x/task-store.js';
import { A2XServer } from '../a2x/a2x-agent.js';
import { DefaultRequestHandler } from './request-handler.js';
import { createSSEStream } from './sse-handler.js';
import type { RequestContext } from '../types/auth.js';
import { JSONParseError } from '../types/errors.js';
import {
  A2A_HTTP_JSON_MEDIA_TYPE,
  HttpJsonRequestHandler,
  toHttpJsonErrorResponse,
} from './http-json-handler.js';
import type { A2ATransport } from '../types/transport.js';
import { A2A_TRANSPORTS } from '../types/transport.js';

const REQUEST_BODY_LIMIT_BYTES = 1024 * 1024;

export interface ToA2xOptions {
  port?: number;
  defaultUrl: string;
  skills?: A2XAgentSkill[];
  streamingMode?: StreamingMode;
  securitySchemes?: Record<string, BaseSecurityScheme>;
  securityRequirements?: SecurityRequirement[];
  protocolVersion?: ProtocolVersion;
  /** Protocol bindings to expose. Defaults to JSONRPC only. */
  transports?: readonly A2ATransport[];
}

export interface ToA2xResult {
  handler: DefaultRequestHandler;
  httpJsonHandler?: HttpJsonRequestHandler;
  a2xServer: A2XServer;
  /** @deprecated Renamed to {@link ToA2xResult.a2xServer}. Use `a2xServer`. */
  a2xAgent: A2XServer;
  listen(port?: number): Promise<void>;
}

export interface A2xRequestListenerOptions {
  /** Explicitly mounted HTTP+JSON handler. Omit to serve JSON-RPC only. */
  httpJsonHandler?: HttpJsonRequestHandler;
  /** Whether to accept JSON-RPC requests. Defaults to true. */
  jsonRpcEnabled?: boolean;
}

/**
 * Convert an LlmAgent to an A2A server with minimal configuration.
 */
export function toA2x(
  agent: LlmAgent,
  options: ToA2xOptions,
): ToA2xResult {
  const runner = new InMemoryRunner({
    agent,
    appName: agent.name,
  });

  const agentExecutor = new AgentExecutor({
    runner,
    runConfig: {
      streamingMode: options.streamingMode ?? StreamingMode.SSE,
    },
  });

  const taskStore = new InMemoryTaskStore();
  const a2xServer = new A2XServer({
    taskStore,
    executor: agentExecutor,
    protocolVersion: options.protocolVersion,
  });

  // Apply configuration. The first binding is the primary AgentInterface;
  // additional bindings share the URL and expose their binding-specific
  // routes beneath it.
  const transports = [...new Set(
    options.transports ?? [A2A_TRANSPORTS.JSONRPC],
  )];
  if (transports.length === 0) {
    throw new Error('toA2x: at least one transport is required');
  }
  const invalidTransport = transports.find(
    (transport) =>
      transport !== A2A_TRANSPORTS.JSONRPC &&
      transport !== A2A_TRANSPORTS.HTTP_JSON,
  );
  if (invalidTransport) {
    throw new Error(`toA2x: unsupported transport '${invalidTransport}'`);
  }
  if (
    (options.protocolVersion ?? '1.0') === '0.3' &&
    transports.some((transport) => transport !== A2A_TRANSPORTS.JSONRPC)
  ) {
    throw new Error('toA2x: HTTP+JSON requires protocolVersion "1.0"');
  }
  a2xServer
    .setDefaultUrl(options.defaultUrl)
    .setDefaultTransport(transports[0]!);
  for (const transport of transports.slice(1)) {
    a2xServer.addInterface({
      url: options.defaultUrl,
      protocol: transport,
      protocolVersion: options.protocolVersion ?? '1.0',
    });
  }

  if (options.skills) {
    for (const skill of options.skills) {
      a2xServer.addSkill(skill);
    }
  }

  if (options.securitySchemes) {
    for (const [name, scheme] of Object.entries(options.securitySchemes)) {
      a2xServer.addSecurityScheme(name, scheme);
    }
  }

  if (options.securityRequirements) {
    for (const req of options.securityRequirements) {
      a2xServer.addSecurityRequirement(req);
    }
  }

  const handler = new DefaultRequestHandler(a2xServer);
  const httpJsonHandler = transports.includes(A2A_TRANSPORTS.HTTP_JSON)
    ? new HttpJsonRequestHandler(handler, {
        basePath: new URL(options.defaultUrl).pathname,
      })
    : undefined;

  return {
    handler,
    ...(httpJsonHandler ? { httpJsonHandler } : {}),
    a2xServer,
    // Deprecated alias — same instance, kept for backward compatibility.
    a2xAgent: a2xServer,
    async listen(port?: number): Promise<void> {
      const listenPort = port ?? options.port ?? 3000;

      const { createServer } = await import('node:http');

      const server = createServer(
        createA2xRequestListener(handler, `http://localhost:${listenPort}`, {
          httpJsonHandler,
          jsonRpcEnabled: transports.includes(A2A_TRANSPORTS.JSONRPC),
        }),
      );

      return new Promise<void>((resolve) => {
        server.listen(listenPort, () => {
          resolve();
        });
      });
    },
  };
}

/**
 * Build a Node.js `http.RequestListener` for AgentCard discovery, JSON-RPC,
 * and explicitly supplied HTTP+JSON adapters.
 *
 * Exported separately so it can be unit-tested without going through
 * `listen(port)` (which never resolves until the server closes), and so
 * embedders that already own an `http.Server` can install our dispatch
 * without recreating one.
 *
 * `defaultOrigin` is the synthetic origin used to resolve relative
 * `req.url` values into a `URL` object. It only affects URL parsing —
 * the actual HTTP host comes from the request itself.
 */
export function createA2xRequestListener(
  handler: DefaultRequestHandler,
  defaultOrigin = 'http://localhost',
  options?: A2xRequestListenerOptions,
): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> {
  return async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    const requestedHeaders = req.headers['access-control-request-headers'];
    res.setHeader(
      'Access-Control-Allow-Headers',
      Array.isArray(requestedHeaders)
        ? requestedHeaders.join(', ')
        : (requestedHeaders ??
          'Content-Type, Authorization, A2A-Version, A2A-Extensions, X-A2A-Extensions'),
    );
    res.setHeader('Vary', 'Access-Control-Request-Headers');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url ?? '/', defaultOrigin);
    const context: RequestContext = {
      headers: req.headers as Record<string, string | string[] | undefined>,
      query: Object.fromEntries(parsedUrl.searchParams.entries()),
    };

    // GET /.well-known/agent.json or /.well-known/agent-card.json.
    // Both paths are valid agent-card discovery endpoints — the v0.3
    // spec uses `agent.json`, the modern spec and our own client
    // (`agent-card-resolver.ts:15-18`) try `agent-card.json` first.
    // Serving both means a client that hits the modern path doesn't
    // get a 404 before it can fall back.
    if (
      req.method === 'GET' &&
      (parsedUrl.pathname === '/.well-known/agent.json' ||
        parsedUrl.pathname === '/.well-known/agent-card.json')
    ) {
      try {
        const card = handler.getAgentCard();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(card));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error: error instanceof Error ? error.message : 'Internal error',
          }),
        );
      }
      return;
    }

    const restHandler = options?.httpJsonHandler;
    if (restHandler?.canHandle(req.method ?? 'GET', parsedUrl)) {
      let parsedBody: unknown;
      if (req.method === 'POST') {
        let requestBody: Awaited<ReturnType<typeof readRequestBody>>;
        try {
          requestBody = await readRequestBody(req);
        } catch (error) {
          const errorResponse = toHttpJsonErrorResponse(error);
          res.writeHead(errorResponse.status, errorResponse.headers);
          res.end(JSON.stringify(errorResponse.body));
          return;
        }
        if (!requestBody.ok) {
          writeHttpJsonPayloadTooLarge(res);
          return;
        }
        const body = requestBody.body;
        if (body.length > 0) {
          try {
            parsedBody = JSON.parse(body);
          } catch {
            const errorResponse = toHttpJsonErrorResponse(
              new JSONParseError('Invalid JSON request body'),
            );
            res.writeHead(errorResponse.status, errorResponse.headers);
            res.end(JSON.stringify(errorResponse.body));
            return;
          }
        }
      } else {
        // A body is not part of any HTTP+JSON GET or DELETE operation, but it
        // still has to be consumed so the socket remains reusable.
        drainRequest(req);
      }
      const response = await restHandler.handle({
        method: req.method ?? 'GET',
        url: parsedUrl,
        body: parsedBody,
        context,
      });
      res.writeHead(response.status, response.headers);
      if (isAsyncGenerator(response.body)) {
        await writeSseResponse(res, response.body);
      } else {
        res.end(JSON.stringify(response.body));
      }
      return;
    }

    // POST /a2a (JSON-RPC)
    if (req.method === 'POST' && options?.jsonRpcEnabled !== false) {
      let requestBody: Awaited<ReturnType<typeof readRequestBody>>;
      try {
        requestBody = await readRequestBody(req);
      } catch (error) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32603,
              message: error instanceof Error ? error.message : 'Internal error',
            },
          }),
        );
        return;
      }
      if (!requestBody.ok) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: {
              code: -32600,
              message: `Request body exceeds the ${REQUEST_BODY_LIMIT_BYTES}-byte limit`,
            },
          }),
        );
        return;
      }
      const body = requestBody.body;

      // JSON-RPC over HTTP convention: parse and handler errors are
      // surfaced as JSON-RPC error responses with HTTP 200, not as
      // 4xx/5xx — clients that skip body parsing on 4xx would never
      // see the JSON-RPC error code otherwise. Mirrors the contract
      // already implemented in DefaultRequestHandler.handle() for
      // string bodies (request-handler.ts:96-106).
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id: null,
            error: { code: -32700, message: 'Parse error' },
          }),
        );
        return;
      }

      let result: Awaited<ReturnType<typeof handler.handle>>;
      try {
        result = await handler.handle(parsed, context);
      } catch (err) {
        const id =
          parsed && typeof parsed === 'object' && 'id' in parsed
            ? (parsed as { id: unknown }).id
            : null;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            jsonrpc: '2.0',
            id,
            error: {
              code: -32603,
              message: err instanceof Error ? err.message : 'Internal error',
            },
          }),
        );
        return;
      }

      // Streaming → AsyncGenerator → SSE
      if (
        result &&
        typeof result === 'object' &&
        Symbol.asyncIterator in result
      ) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });

        const stream = createSSEStream(result as AsyncGenerator<never>);
        const reader = stream.getReader();

        // On client TCP close, cancel the reader so the source generator
        // terminates and aborts in-flight LLM calls. Use res.on('close')
        // — req.on('close') fires when the request body stream is
        // consumed (before response writing), so it misses the later
        // disconnect during streaming. res.close also fires after a
        // normal res.end(), at which point cancel() is a harmless no-op.
        const cancelReader = () => {
          void reader.cancel().catch(() => {});
        };
        res.on('close', cancelReader);

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(
              typeof value === 'string'
                ? value
                : new TextDecoder().decode(value),
            );
          }
        } catch (error) {
          const errorData = JSON.stringify({
            error: error instanceof Error ? error.message : 'Internal error',
          });
          res.write(`event: error\ndata: ${errorData}\n\n`);
        }
        res.end();
        return;
      }

      // Standard JSON-RPC response
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result));
      return;
    }

    res.writeHead(404);
    res.end('Not Found');
  };
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator<unknown> {
  return Boolean(value && typeof value === 'object' && Symbol.asyncIterator in value);
}

async function readRequestBody(
  req: import('node:http').IncomingMessage,
): Promise<{ ok: true; body: string } | { ok: false }> {
  const contentLength = Number(req.headers['content-length']);
  if (
    Number.isFinite(contentLength) &&
    contentLength > REQUEST_BODY_LIMIT_BYTES
  ) {
    drainRequest(req);
    return { ok: false };
  }

  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let byteLength = 0;

    const cleanup = () => {
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      req.off('aborted', onAborted);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      byteLength += buffer.byteLength;
      if (byteLength > REQUEST_BODY_LIMIT_BYTES) {
        cleanup();
        drainRequest(req);
        resolve({ ok: false });
        return;
      }
      chunks.push(buffer);
    };
    const onEnd = () => {
      cleanup();
      resolve({ ok: true, body: Buffer.concat(chunks).toString('utf8') });
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onAborted = () => {
      cleanup();
      // Node may emit ECONNRESET after `aborted`; keep it from becoming an
      // unhandled EventEmitter error after this promise has already settled.
      req.once('error', () => {});
      reject(new Error('Request aborted while reading body'));
    };

    req.once('end', onEnd);
    req.once('error', onError);
    req.once('aborted', onAborted);
    // Register data last because it switches the request into flowing mode.
    req.on('data', onData);
  });
}

function drainRequest(req: import('node:http').IncomingMessage): void {
  // An oversized client may disconnect while the unread remainder is being
  // discarded. Consume that error so the server process stays alive.
  req.once('error', () => {});
  req.resume();
}

function writeHttpJsonPayloadTooLarge(
  res: import('node:http').ServerResponse,
): void {
  res.writeHead(413, { 'Content-Type': A2A_HTTP_JSON_MEDIA_TYPE });
  res.end(
    JSON.stringify({
      error: {
        code: 413,
        status: 'RESOURCE_EXHAUSTED',
        message: `Request body exceeds the ${REQUEST_BODY_LIMIT_BYTES}-byte limit`,
        details: [
          {
            '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
            reason: 'REQUEST_BODY_TOO_LARGE',
            domain: 'a2a-protocol.org',
            metadata: {
              maxBytes: String(REQUEST_BODY_LIMIT_BYTES),
            },
          },
        ],
      },
    }),
  );
}

async function writeSseResponse(
  res: import('node:http').ServerResponse,
  events: AsyncGenerator<unknown>,
): Promise<void> {
  let closed = false;
  const markClosed = () => {
    closed = true;
  };
  res.on('close', markClosed);
  try {
    for await (const event of events) {
      if (closed) break;
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }
  } finally {
    if (closed) {
      await events.return(undefined).catch(() => {});
    } else {
      res.end();
    }
  }
}
