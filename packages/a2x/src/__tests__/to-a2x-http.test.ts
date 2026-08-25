/**
 * Integration tests for the toA2x() HTTP wrapper.
 *
 * Verifies the JSON-RPC over HTTP convention: parse and handler errors
 * are surfaced as JSON-RPC error responses with HTTP 200, not 4xx —
 * see issue #122.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import type { AddressInfo } from 'node:net';
import { LlmAgent } from '../agent/llm-agent.js';
import { BaseLlmProvider } from '../provider/base.js';
import { toA2x, createA2xRequestListener } from '../transport/to-a2x.js';
import { A2A_TRANSPORTS } from '../types/transport.js';
import type { AgentCardV10 } from '../types/agent-card.js';
import { BaseAgent } from '../agent/base-agent.js';
import type { AgentEvent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { InMemoryTaskStore } from '../a2x/task-store.js';
import { A2XServer } from '../a2x/a2x-agent.js';
import { DefaultRequestHandler } from '../transport/request-handler.js';
import { TaskState } from '../types/task.js';

// Side-effect import to register response mappers (v0.3 / v1.0).
import '../a2x/index.js';

class NoopProvider extends BaseLlmProvider {
  readonly name = 'noop';
  constructor() {
    super({ model: 'noop' });
  }
  async generateContent() {
    return { content: [], finishReason: 'stop' as const };
  }
}

class GatedHttpAgent extends BaseAgent {
  readonly release = Promise.withResolvers<void>();
  capturedSignal: AbortSignal | undefined;

  constructor() {
    super({ name: 'gated-http-agent', description: 'Waits during streaming' });
  }

  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    this.capturedSignal = context.signal;
    yield { type: 'text', text: 'before-disconnect', role: 'agent' };
    await this.release.promise;
    yield { type: 'text', text: 'after-disconnect', role: 'agent' };
    yield { type: 'done' };
  }
}

describe('toA2x() HTTP wrapper — JSON-RPC over HTTP error convention', () => {
  let baseUrl: string;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const agent = new LlmAgent({
      name: 'noop-agent',
      provider: new NoopProvider(),
      instruction: 'noop',
    });
    const a2x = toA2x(agent, { defaultUrl: 'http://localhost/a2a' });

    // Use the exported request listener so this test exercises the same
    // code path the production listen() does, then bind on an ephemeral
    // port so tests can run in parallel.
    const { createServer } = await import('node:http');
    const server = createServer(createA2xRequestListener(a2x.handler));
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    stop = () =>
      new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
  });

  afterAll(async () => {
    await stop?.();
  });

  it('echoes requested CORS headers for configured authentication schemes', async () => {
    const res = await fetch(`${baseUrl}/a2a`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://client.example.com',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'content-type, x-api-key',
      },
    });

    expect(res.status).toBe(204);
    expect(res.headers.get('access-control-allow-headers')).toBe(
      'content-type, x-api-key',
    );
    expect(res.headers.get('vary')).toContain('Access-Control-Request-Headers');
  });

  it('returns HTTP 200 with -32700 body for malformed JSON', async () => {
    const res = await fetch(`${baseUrl}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{not valid json',
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: unknown;
      error: { code: number; message: string };
    };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.id).toBeNull();
    expect(body.error.code).toBe(-32700);
  });

  it('rejects JSON-RPC request bodies larger than 1 MiB', async () => {
    const res = await fetch(`${baseUrl}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }),
    });

    expect(res.status).toBe(413);
    await expect(res.json()).resolves.toMatchObject({
      jsonrpc: '2.0',
      id: null,
      error: {
        code: -32600,
        message: 'Request body exceeds the 1048576-byte limit',
      },
    });
  });

  // Both `/.well-known/agent.json` (v0.3 spec) and
  // `/.well-known/agent-card.json` (modern spec / our own client tries
  // this first) must serve the AgentCard. Issue #142 fix 3.
  it.each([
    '/.well-known/agent.json',
    '/.well-known/agent-card.json',
  ])('serves the AgentCard at %s', async (path) => {
    const res = await fetch(`${baseUrl}${path}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('vary')).toBeNull();
    expect(res.headers.get('access-control-allow-headers')).toBeNull();
    const card = (await res.json()) as { name: string };
    expect(card.name).toBe('noop-agent');
  });

  it('returns HTTP 200 with a JSON-RPC error body for an unrecognized method', async () => {
    // The handler returns a JSON-RPC error response (it does not throw)
    // for an unknown method; the wrapper passes that through with HTTP
    // 200. Belt-and-suspenders proof that we are not coercing the
    // handler's structured error into a 4xx anywhere.
    const res = await fetch(`${baseUrl}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 7,
        method: 'does/not/exist',
        params: {},
      }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      jsonrpc: string;
      id: unknown;
      error: { code: number; message: string };
    };
    expect(body.id).toBe(7);
    expect(body.error.code).toBeLessThan(0);
  });

  it('advertises and mounts only explicitly configured transports', () => {
    const agent = new LlmAgent({
      name: 'multi-transport-agent',
      provider: new NoopProvider(),
      instruction: 'noop',
    });
    const jsonRpcOnly = toA2x(agent, {
      defaultUrl: 'http://localhost/a2a',
    });
    expect(jsonRpcOnly.httpJsonHandler).toBeUndefined();
    expect((jsonRpcOnly.handler.getAgentCard() as AgentCardV10).supportedInterfaces)
      .toHaveLength(1);

    const both = toA2x(agent, {
      defaultUrl: 'http://localhost/a2a',
      transports: [A2A_TRANSPORTS.HTTP_JSON, A2A_TRANSPORTS.JSONRPC],
    });
    expect(both.httpJsonHandler).toBeDefined();
    expect(
      (both.handler.getAgentCard() as AgentCardV10).supportedInterfaces.map(
        (iface) => iface.protocolBinding,
      ),
    ).toEqual(['HTTP+JSON', 'JSONRPC']);
  });

  it('keeps a JSON-RPC task running after a real TCP disconnect', async () => {
    const agent = new GatedHttpAgent();
    const taskStore = new InMemoryTaskStore();
    const a2xServer = new A2XServer({
      taskStore,
      executor: new AgentExecutor({
        runner: new InMemoryRunner({ agent, appName: 'tcp-test' }),
        runConfig: { streamingMode: StreamingMode.SSE },
      }),
      protocolVersion: '1.0',
    }).setDefaultUrl('http://127.0.0.1/a2a');
    const handler = new DefaultRequestHandler(a2xServer);
    const { createServer } = await import('node:http');
    const server = createServer(createA2xRequestListener(handler));
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();

    try {
      const response = await fetch(`http://127.0.0.1:${port}/a2a`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/stream',
          params: {
            message: {
              messageId: 'tcp-disconnect',
              role: 'user',
              parts: [{ text: 'Hello' }],
            },
          },
        }),
        signal: controller.signal,
      });
      const reader = response.body!.getReader();
      const first = await reader.read();
      const envelope = JSON.parse(
        new TextDecoder()
          .decode(first.value)
          .split('\n\n', 1)[0]!
          .replace(/^data: /, '')
          .trim(),
      ) as { result: { taskId: string } };
      const taskId = envelope.result.taskId;

      controller.abort();
      agent.release.resolve();

      expect(
        await waitUntil(async () => {
          const task = await taskStore.getTask(taskId);
          return task?.status.state === TaskState.COMPLETED;
        }),
      ).toBe(true);
      expect(agent.capturedSignal?.aborted).toBe(false);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });
});

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 1_000,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}
