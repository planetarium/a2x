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
import { A2XAgent } from '../a2x/a2x-agent.js';
import { DefaultRequestHandler } from './request-handler.js';
import { createSSEStream } from './sse-handler.js';
import type { RequestContext } from '../types/auth.js';

export interface ToA2xOptions {
  port?: number;
  defaultUrl: string;
  skills?: A2XAgentSkill[];
  streamingMode?: StreamingMode;
  securitySchemes?: Record<string, BaseSecurityScheme>;
  securityRequirements?: SecurityRequirement[];
  protocolVersion?: ProtocolVersion;
}

export interface ToA2xResult {
  handler: DefaultRequestHandler;
  a2xAgent: A2XAgent;
  listen(port?: number): Promise<void>;
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
  const a2xAgent = new A2XAgent({
    taskStore,
    executor: agentExecutor,
    protocolVersion: options.protocolVersion,
  });

  // Apply configuration
  a2xAgent.setDefaultUrl(options.defaultUrl);

  if (options.skills) {
    for (const skill of options.skills) {
      a2xAgent.addSkill(skill);
    }
  }

  if (options.securitySchemes) {
    for (const [name, scheme] of Object.entries(options.securitySchemes)) {
      a2xAgent.addSecurityScheme(name, scheme);
    }
  }

  if (options.securityRequirements) {
    for (const req of options.securityRequirements) {
      a2xAgent.addSecurityRequirement(req);
    }
  }

  const handler = new DefaultRequestHandler(a2xAgent);

  return {
    handler,
    a2xAgent,
    async listen(port?: number): Promise<void> {
      const listenPort = port ?? options.port ?? 3000;

      const { createServer } = await import('node:http');

      const server = createServer(
        createA2xRequestListener(handler, `http://localhost:${listenPort}`),
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
 * Build a Node.js `http.RequestListener` that dispatches `/.well-known/`
 * card lookups to `handler.getAgentCard()` and `POST /a2a` JSON-RPC
 * requests through `handler.handle()`.
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
): (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => Promise<void> {
  return async (req, res) => {
    // CORS headers
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const parsedUrl = new URL(req.url ?? '/', defaultOrigin);

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

    // POST /a2a (JSON-RPC)
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }

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

      const context: RequestContext = {
        headers: req.headers as Record<string, string | string[] | undefined>,
        query: Object.fromEntries(parsedUrl.searchParams.entries()),
      };

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
