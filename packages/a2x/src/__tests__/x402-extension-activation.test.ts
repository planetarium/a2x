/**
 * Tests for spec a2a-x402 v0.2 §8 extension activation. Clients MUST
 * include the extension URI in the `X-A2A-Extensions` HTTP header, and
 * servers with `required: true` extensions on their AgentCard MUST reject
 * requests missing the URI.
 */
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { A2XClient } from '../client/a2x-client.js';
import { X402_EXTENSION_URI } from '../x402/index.js';
import { A2XAgent } from '../a2x/a2x-agent.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { BaseAgent, type AgentEvent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';
import { InMemoryTaskStore } from '../a2x/task-store.js';
import { DefaultRequestHandler } from '../transport/request-handler.js';
// Ensure response mappers are registered (side-effect import).
import '../a2x/index.js';

const TEST_ACCOUNT = privateKeyToAccount(
  '0x1111111111111111111111111111111111111111111111111111111111111111',
);

class EchoAgent extends BaseAgent {
  constructor() {
    super({ name: 'echo', description: 'echo' });
  }
  async *run(_ctx: InvocationContext): AsyncGenerator<AgentEvent> {
    yield { type: 'text', text: 'hi', role: 'agent' };
    yield { type: 'done' };
  }
}

/**
 * Build a fake `fetch` that records every request's headers and returns
 * a minimal AgentCard on the first call and a generic JSON-RPC success
 * on every subsequent call. Lets the client resolve without talking to
 * an actual server.
 */
function recordingFetch(): {
  fetch: typeof globalThis.fetch;
  calls: Array<{ url: string; headers: Record<string, string> }>;
} {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const src = init.headers as Record<string, string>;
      for (const key of Object.keys(src)) headers[key.toLowerCase()] = src[key]!;
    }
    calls.push({ url, headers });

    // AgentCard resolution hits /.well-known/agent-card.json or
    // /.well-known/agent.json — return a minimal card.
    if (url.endsWith('/agent-card.json') || url.endsWith('/agent.json')) {
      return new Response(
        JSON.stringify({
          protocolVersion: '0.3.0',
          name: 'test',
          description: 'test',
          url: 'https://example.com/a2a',
          version: '1.0.0',
          capabilities: {},
          defaultInputModes: ['text'],
          defaultOutputModes: ['text'],
          skills: [],
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }

    // Default: a synthetic completed task.
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        result: {
          kind: 'task',
          id: 't1',
          contextId: 'c1',
          status: { state: 'completed', timestamp: new Date().toISOString() },
          artifacts: [],
          history: [],
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, calls };
}

describe('A2XClient — X-A2A-Extensions header (spec §8)', () => {
  it('omits the header when no extensions are registered', async () => {
    const { fetch, calls } = recordingFetch();
    const client = new A2XClient('https://example.com', { fetch });
    await client.sendMessage({
      message: {
        messageId: 'm1',
        role: 'user',
        parts: [{ text: 'hi' }],
      },
    });
    const rpcCall = calls.find((c) => c.url.endsWith('/a2a'))!;
    expect(rpcCall.headers['x-a2a-extensions']).toBeUndefined();
  });

  it('emits the header when extensions are passed via constructor', async () => {
    const { fetch, calls } = recordingFetch();
    const client = new A2XClient('https://example.com', {
      fetch,
      extensions: ['https://example.org/ext-a', 'https://example.org/ext-b'],
    });
    await client.sendMessage({
      message: {
        messageId: 'm1',
        role: 'user',
        parts: [{ text: 'hi' }],
      },
    });
    const rpcCall = calls.find((c) => c.url.endsWith('/a2a'))!;
    expect(rpcCall.headers['x-a2a-extensions']).toContain('ext-a');
    expect(rpcCall.headers['x-a2a-extensions']).toContain('ext-b');
  });

  it('auto-registers the x402 extension URI when the x402 option is supplied', async () => {
    const { fetch, calls } = recordingFetch();
    const client = new A2XClient('https://example.com', {
      fetch,
      x402: { signer: TEST_ACCOUNT },
    });
    await client.sendMessage({
      message: {
        messageId: 'm1',
        role: 'user',
        parts: [{ text: 'hi' }],
      },
    });
    const rpcCall = calls.find((c) => c.url.endsWith('/a2a'))!;
    expect(rpcCall.headers['x-a2a-extensions']).toBe(X402_EXTENSION_URI);
    expect(client.activatedExtensions).toContain(X402_EXTENSION_URI);
  });
});

describe('DefaultRequestHandler — extension activation enforcement (spec §3.1 / §8)', () => {
  function buildHandler(required: boolean): DefaultRequestHandler {
    const agent = new EchoAgent();
    const runner = new InMemoryRunner({ agent, appName: 'test' });
    const executor = new AgentExecutor({
      runner,
      runConfig: { streamingMode: StreamingMode.SSE },
    });
    const a2x = new A2XAgent({
      taskStore: new InMemoryTaskStore(),
      executor,
      protocolVersion: '0.3',
    })
      .setName('x')
      .setDescription('x')
      .setDefaultUrl('https://example.com/a2a')
      .addExtension({ uri: X402_EXTENSION_URI, required });
    return new DefaultRequestHandler(a2x);
  }

  const sendBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params: {
      message: {
        messageId: 'm1',
        role: 'user',
        parts: [{ kind: 'text', text: 'hi' }],
      },
    },
  };

  it('rejects the request when a required extension is not activated', async () => {
    const handler = buildHandler(true);
    const result = (await handler.handle(sendBody, { headers: {} })) as {
      error?: { code: number; message: string };
    };
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe(-32600);
    expect(result.error!.message).toContain(X402_EXTENSION_URI);
  });

  it('accepts the request when the required extension is listed in X-A2A-Extensions', async () => {
    const handler = buildHandler(true);
    const result = (await handler.handle(sendBody, {
      headers: { 'x-a2a-extensions': X402_EXTENSION_URI },
    })) as { result?: unknown; error?: unknown };
    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
  });

  it('accepts the request when required=false even without the header', async () => {
    const handler = buildHandler(false);
    const result = (await handler.handle(sendBody, { headers: {} })) as {
      result?: unknown;
      error?: unknown;
    };
    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
  });

  it('parses comma-separated extension URIs', async () => {
    const handler = buildHandler(true);
    const result = (await handler.handle(sendBody, {
      headers: {
        'x-a2a-extensions': `https://example.org/other, ${X402_EXTENSION_URI}`,
      },
    })) as { result?: unknown; error?: unknown };
    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
  });

  it('skips the check entirely when context is not provided (in-process callers)', async () => {
    const handler = buildHandler(true);
    // No context → skip spec-header enforcement (matches the auth fallback).
    const result = (await handler.handle(sendBody)) as {
      result?: unknown;
      error?: unknown;
    };
    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
  });
});
