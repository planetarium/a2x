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
});
