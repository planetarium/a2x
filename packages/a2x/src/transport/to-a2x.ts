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

      const server = createServer(async (req, res) => {
        // CORS headers
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

        if (req.method === 'OPTIONS') {
          res.writeHead(204);
          res.end();
          return;
        }

        // GET /.well-known/agent.json
        const parsedUrl = new URL(
          req.url!,
          `http://localhost:${listenPort}`,
        );
        if (
          req.method === 'GET' &&
          parsedUrl.pathname === '/.well-known/agent.json'
        ) {
          const version =
            parsedUrl.searchParams.get('version') ?? undefined;

          try {
            const card = handler.getAgentCard(version);
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

          try {
            const parsed = JSON.parse(body);
            const context: RequestContext = {
              headers: req.headers as Record<string, string | string[] | undefined>,
              query: Object.fromEntries(parsedUrl.searchParams.entries()),
            };
            const result = await handler.handle(parsed, context);

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

              const stream = createSSEStream(
                result as AsyncGenerator<never>,
              );
              const reader = stream.getReader();

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
                  error:
                    error instanceof Error
                      ? error.message
                      : 'Internal error',
                });
                res.write(`event: error\ndata: ${errorData}\n\n`);
              }
              res.end();
              return;
            }

            // Standard JSON-RPC response
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(
              JSON.stringify({
                jsonrpc: '2.0',
                id: null,
                error: { code: -32700, message: 'Parse error' },
              }),
            );
          }
          return;
        }

        res.writeHead(404);
        res.end('Not Found');
      });

      return new Promise<void>((resolve) => {
        server.listen(listenPort, () => {
          resolve();
        });
      });
    },
  };
}
