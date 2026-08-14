/**
 * Tests for the CLI's x402 settings builder — in particular the issue-#225
 * scenario: a V2 `upto`-only offer with gas-sponsored Permit2 approval and
 * no pre-existing allowance, driven through the exact
 * `A2XClientX402Options` block `a2x a2a send` / `stream` hand to
 * `A2XClient`.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createServer, type Server } from 'node:http';
import { A2XClient } from '@a2x/sdk';
import { X402PaymentFailedError } from '@a2x/sdk/x402';
import {
  buildBudgetedX402ClientSettings,
  printX402Error,
  X402BudgetExceededError,
  X402UptoConsentRequiredError,
} from '../x402-cli.js';
import { getRpcUrl } from '../config.js';

const TEST_PRIVATE_KEY =
  '0x1111111111111111111111111111111111111111111111111111111111111111';

// The builder needs a viem LocalAccount; import lazily to keep the top of
// the file dependency-light.
const { privateKeyToAccount } = await import('viem/accounts');
const SIGNER = privateKeyToAccount(TEST_PRIVATE_KEY);

const X402_STATUS_KEY = 'x402.payment.status';
const X402_REQUIRED_KEY = 'x402.payment.required';
const X402_PAYLOAD_KEY = 'x402.payment.payload';
const X402_RECEIPTS_KEY = 'x402.payment.receipts';
const X402_ERROR_KEY = 'x402.payment.error';

const UPTO_ACCEPT = {
  scheme: 'upto',
  network: 'eip155:84532',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  amount: '5000',
  payTo: '0x2222222222222222222222222222222222222222',
  maxTimeoutSeconds: 300,
  extra: {
    name: 'USDC',
    version: '2',
    facilitatorAddress: '0x4444444444444444444444444444444444444444',
  },
};

const EXACT_ACCEPT = {
  scheme: 'exact',
  network: 'eip155:84532',
  amount: '1000',
  asset: UPTO_ACCEPT.asset,
  payTo: UPTO_ACCEPT.payTo,
  maxTimeoutSeconds: 300,
  extra: { name: 'USDC', version: '2' },
};

function requiredEnvelope(accepts: unknown[], extensions?: unknown) {
  return {
    x402Version: 2,
    resource: { url: 'https://example.com/protected' },
    accepts,
    ...(extensions !== undefined ? { extensions } : {}),
  };
}

// Silence the requirement pretty-printer — these tests assert on behavior,
// not terminal output.
beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildBudgetedX402ClientSettings', () => {
  it('omits allowUpto and upto unless explicitly configured', () => {
    const settings = buildBudgetedX402ClientSettings({
      signer: SIGNER,
      maxAmount: 10_000n,
    });
    // Key presence matters: the SDK treats a present-but-undefined key the
    // same, but the CLI should not even hint at a consent it wasn't given.
    expect('allowUpto' in settings).toBe(false);
    expect('upto' in settings).toBe(false);
  });

  it('passes allowUpto and the upto RPC config through when set', () => {
    const settings = buildBudgetedX402ClientSettings({
      signer: SIGNER,
      maxAmount: 10_000n,
      allowUpto: true,
      rpcUrl: 'https://rpc.example',
    });
    expect(settings.allowUpto).toBe(true);
    expect(settings.upto).toEqual({ rpcUrl: 'https://rpc.example' });
  });

  it('drops the RPC config without --allow-upto consent', () => {
    // A globally configured A2X_RPC_URL must not leak into consent-less
    // invocations: without allowUpto no upto offer can be selected, and the
    // config's mere presence would make the SDK bypass its per-signer
    // runtime cache on every signing attempt.
    const settings = buildBudgetedX402ClientSettings({
      signer: SIGNER,
      maxAmount: 10_000n,
      rpcUrl: 'https://rpc.example',
    });
    expect('upto' in settings).toBe(false);
  });

  it('throws X402UptoConsentRequiredError for an affordable upto-only offer without --allow-upto', () => {
    const settings = buildBudgetedX402ClientSettings({
      signer: SIGNER,
      maxAmount: 10_000n,
    });
    expect(() =>
      settings.onPaymentRequired!(
        requiredEnvelope([UPTO_ACCEPT]) as never,
      ),
    ).toThrow(X402UptoConsentRequiredError);
  });

  it('does not demand upto consent when an affordable exact offer exists', () => {
    const settings = buildBudgetedX402ClientSettings({
      signer: SIGNER,
      maxAmount: 10_000n,
    });
    expect(() =>
      settings.onPaymentRequired!(
        requiredEnvelope([UPTO_ACCEPT, EXACT_ACCEPT]) as never,
      ),
    ).not.toThrow();
  });

  it('accepts an upto-only offer under --allow-upto', () => {
    const settings = buildBudgetedX402ClientSettings({
      signer: SIGNER,
      maxAmount: 10_000n,
      allowUpto: true,
    });
    expect(() =>
      settings.onPaymentRequired!(
        requiredEnvelope([UPTO_ACCEPT]) as never,
      ),
    ).not.toThrow();
  });

  it('still enforces the budget first, even on upto offers', () => {
    const settings = buildBudgetedX402ClientSettings({
      signer: SIGNER,
      maxAmount: 100n,
      allowUpto: true,
    });
    expect(() =>
      settings.onPaymentRequired!(
        requiredEnvelope([UPTO_ACCEPT]) as never,
      ),
    ).toThrow(X402BudgetExceededError);
  });
});

describe('getRpcUrl', () => {
  const saved = process.env.A2X_RPC_URL;
  afterEach(() => {
    if (saved === undefined) delete process.env.A2X_RPC_URL;
    else process.env.A2X_RPC_URL = saved;
  });

  it('prefers the --rpc-url override over the environment', () => {
    process.env.A2X_RPC_URL = 'https://env.example';
    expect(getRpcUrl('https://flag.example')).toBe('https://flag.example');
  });

  it('falls back to A2X_RPC_URL', () => {
    process.env.A2X_RPC_URL = 'https://env.example';
    expect(getRpcUrl(undefined)).toBe('https://env.example');
  });
});

// ─── End-to-end: V2 upto-only offer + gas-sponsored Permit2 approval ──

/**
 * Stub EVM JSON-RPC endpoint. Answers every eth_call with 32 zero bytes:
 * a zero Permit2 allowance (the "no pre-existing allowance" case from
 * issue #225) and EIP-2612 permit nonce 0. Signing never touches it.
 */
function stubRpcServer(): Promise<{ server: Server; url: string }> {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk: Buffer) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      const parsed = JSON.parse(body) as { id: number } | { id: number }[];
      const respond = (r: { id: number }) => ({
        jsonrpc: '2.0',
        id: r.id,
        result: `0x${'0'.repeat(64)}`,
      });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify(
          Array.isArray(parsed) ? parsed.map(respond) : respond(parsed),
        ),
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

/**
 * Minimal in-memory A2A merchant, mimicking the wordchain agent from the
 * issue: offers only a V2 `upto` requirement with gas-sponsored approval,
 * and — like the real x402 facilitator — rejects a resubmission whose
 * payload lacks the gas-sponsoring approval it needs for a payer with no
 * Permit2 allowance.
 */
function merchantFetch(): {
  fetch: typeof globalThis.fetch;
  submissions: Array<Record<string, unknown>>;
} {
  const submissions: Array<Record<string, unknown>> = [];
  const agentCard = {
    protocolVersion: '0.3.0',
    name: 'merchant',
    description: 'test merchant',
    url: 'https://merchant.example/a2a',
    version: '1.0.0',
    capabilities: {},
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [],
  };
  const fetch = (async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.includes('/.well-known/')) {
      return new Response(JSON.stringify(agentCard), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    const body = JSON.parse(init!.body as string) as {
      params: { message: { metadata?: Record<string, unknown> } };
    };
    const metadata = body.params.message.metadata ?? {};
    const task = (status: unknown) => ({
      jsonrpc: '2.0',
      id: 1,
      result: {
        kind: 'task',
        id: 't1',
        contextId: 'c1',
        status,
        artifacts: [],
        history: [],
      },
    });
    if (metadata[X402_STATUS_KEY] !== 'payment-submitted') {
      return new Response(
        JSON.stringify(
          task({
            state: 'input-required',
            timestamp: new Date().toISOString(),
            message: {
              messageId: 'x402-1',
              role: 'agent',
              parts: [{ kind: 'text', text: 'pay up to' }],
              metadata: {
                [X402_STATUS_KEY]: 'payment-required',
                [X402_REQUIRED_KEY]: requiredEnvelope([UPTO_ACCEPT], {
                  eip2612GasSponsoring: {},
                  erc20ApprovalGasSponsoring: {},
                }),
              },
            },
          }),
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    submissions.push(metadata);
    const payload = metadata[X402_PAYLOAD_KEY] as {
      extensions?: { eip2612GasSponsoring?: { info?: unknown } };
    };
    const sponsored = payload.extensions?.eip2612GasSponsoring?.info;
    if (!sponsored) {
      return new Response(
        JSON.stringify(
          task({
            state: 'failed',
            timestamp: new Date().toISOString(),
            message: {
              messageId: 'x402-2',
              role: 'agent',
              parts: [{ kind: 'text', text: 'permit2 allowance required' }],
              metadata: {
                [X402_STATUS_KEY]: 'payment-failed',
                [X402_ERROR_KEY]: 'permit2_allowance_required',
                [X402_RECEIPTS_KEY]: [
                  {
                    success: false,
                    transaction: '',
                    network: UPTO_ACCEPT.network,
                    errorReason: 'permit2_allowance_required',
                  },
                ],
              },
            },
          }),
        ),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    return new Response(
      JSON.stringify(
        task({
          state: 'completed',
          timestamp: new Date().toISOString(),
          message: {
            messageId: 'x402-3',
            role: 'agent',
            parts: [{ kind: 'text', text: 'settled' }],
            metadata: {
              [X402_STATUS_KEY]: 'payment-completed',
              [X402_RECEIPTS_KEY]: [
                {
                  success: true,
                  transaction: '0xabc',
                  network: UPTO_ACCEPT.network,
                  // Metered: the merchant drew less than authorized.
                  extra: { chargedAmount: '123' },
                },
              ],
            },
          },
        }),
      ),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    );
  }) as unknown as typeof globalThis.fetch;
  return { fetch, submissions };
}

describe('a2a send settings vs a V2 upto-only gas-sponsored merchant', () => {
  it('completes the payment with --allow-upto and --rpc-url', async () => {
    const { server, url: rpcUrl } = await stubRpcServer();
    try {
      const { fetch, submissions } = merchantFetch();
      const client = new A2XClient('https://merchant.example', {
        fetch,
        x402: buildBudgetedX402ClientSettings({
          signer: SIGNER,
          maxAmount: 10_000n,
          allowUpto: true,
          rpcUrl,
        }),
      });
      const task = await client.sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: '사과' }] },
      });
      expect(task.status.state).toBe('completed');
      expect(submissions).toHaveLength(1);
      const payload = submissions[0]![X402_PAYLOAD_KEY] as {
        extensions?: { eip2612GasSponsoring?: { info?: { from: string } } };
      };
      expect(
        payload.extensions!.eip2612GasSponsoring!.info!.from.toLowerCase(),
      ).toBe(SIGNER.address.toLowerCase());
    } finally {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
  });

  it('fails with permit2_allowance_required when no RPC endpoint is configured', async () => {
    // The pre-fix behavior from issue #225, kept as a regression pin: consent
    // alone is not enough against this merchant — without --rpc-url the payer
    // cannot produce the gas-sponsored approval.
    const { fetch } = merchantFetch();
    const client = new A2XClient('https://merchant.example', {
      fetch,
      x402: buildBudgetedX402ClientSettings({
        signer: SIGNER,
        maxAmount: 10_000n,
        allowUpto: true,
      }),
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    let caught: unknown;
    try {
      await client.sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: '사과' }] },
      });
    } catch (err) {
      caught = err;
    }
    expect((caught as X402PaymentFailedError).code).toBe(
      'permit2_allowance_required',
    );
    // The CLI's centralised handler must claim this error (exit code 2, not
    // the generic connection-error fallback) even though the class instance
    // comes from `@a2x/sdk`'s independently-bundled entry point, and it
    // should point the user at --rpc-url.
    expect(printX402Error(caught)).toBe(2);
    const printed = (console.error as ReturnType<typeof vi.fn>).mock.calls
      .flat()
      .join('\n');
    expect(printed).toContain('--rpc-url');
  });
});
