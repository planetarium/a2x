/**
 * Tests for `A2XClient`'s native a2a-x402 v0.2 Standalone Flow handling.
 *
 * The dance has two distinct surfaces — `sendMessage` (blocking) and
 * `sendMessageStream` — and both must transparently:
 *
 *  1. Activate the extension via `X-A2A-Extensions` (covered in
 *     `x402-extension-activation.test.ts`).
 *  2. Detect the merchant's `payment-required` reply.
 *  3. Sign one of the merchant's `accepts[]` requirements (subject to
 *     `maxAmount` and any caller-supplied `selectRequirement` /
 *     `onPaymentRequired`).
 *  4. Resubmit on the same task with `x402.payment.submitted` metadata.
 *  5. Surface the final settled task to the caller — no manual dance
 *     orchestration in user code.
 */

import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { A2XClient } from '../client/a2x-client.js';
import {
  X402_EXTENSION_URI,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
} from '../x402/constants.js';
import {
  X402NoSupportedRequirementError,
  X402PaymentFailedError,
} from '../x402/errors.js';

const TEST_ACCOUNT = privateKeyToAccount(
  '0x1111111111111111111111111111111111111111111111111111111111111111',
);

const AGENT_URL = 'https://example.com';
const RPC_PATH = '/a2a';
const RPC_URL = `${AGENT_URL}${RPC_PATH}`;

function agentCardResponse(): Response {
  return new Response(
    JSON.stringify({
      protocolVersion: '0.3.0',
      name: 'test',
      description: 'test',
      url: RPC_URL,
      version: '1.0.0',
      capabilities: {},
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      skills: [],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function paymentRequiredTask(): unknown {
  return {
    kind: 'task',
    id: 't1',
    contextId: 'c1',
    status: {
      state: 'input-required',
      timestamp: new Date().toISOString(),
      message: {
        messageId: 'x402-1',
        role: 'agent',
        parts: [{ kind: 'text', text: 'pay up' }],
        metadata: {
          [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
          [X402_METADATA_KEYS.REQUIRED]: {
            x402Version: 1,
            accepts: [
              {
                scheme: 'exact',
                network: 'base-sepolia',
                maxAmountRequired: '1000',
                resource: 'https://example.com/protected',
                description: 'Per-call',
                mimeType: 'application/json',
                payTo: '0x000000000000000000000000000000000000dEaD',
                maxTimeoutSeconds: 300,
                asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                extra: { name: 'USDC', version: '2' },
              },
            ],
          },
        },
      },
    },
    artifacts: [],
    history: [],
  };
}

function completedTaskWithReceipt(): unknown {
  return {
    kind: 'task',
    id: 't1',
    contextId: 'c1',
    status: {
      state: 'completed',
      timestamp: new Date().toISOString(),
      message: {
        messageId: 'x402-2',
        role: 'agent',
        parts: [{ kind: 'text', text: 'done' }],
        metadata: {
          [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.COMPLETED,
          [X402_METADATA_KEYS.RECEIPTS]: [
            {
              success: true,
              transaction: '0xabc',
              network: 'base-sepolia',
              payer: '0x9999999999999999999999999999999999999999',
            },
          ],
        },
      },
    },
    artifacts: [],
    history: [],
  };
}

function failedTaskWithReceipt(reason: string, code: string): unknown {
  return {
    kind: 'task',
    id: 't1',
    contextId: 'c1',
    status: {
      state: 'failed',
      timestamp: new Date().toISOString(),
      message: {
        messageId: 'x402-2',
        role: 'agent',
        parts: [{ kind: 'text', text: reason }],
        metadata: {
          [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.FAILED,
          [X402_METADATA_KEYS.ERROR]: code,
          [X402_METADATA_KEYS.RECEIPTS]: [
            {
              success: false,
              transaction: '',
              network: 'base-sepolia',
              payer: '0x9999999999999999999999999999999999999999',
              errorReason: reason,
            },
          ],
        },
      },
    },
    artifacts: [],
    history: [],
  };
}

function jsonRpcOk(result: unknown): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Build a fake fetch that serves a sequence of responses for /a2a calls,
 * always returning the AgentCard for /.well-known/* probes.
 */
function scriptedFetch(replies: Array<() => Response>): {
  fetch: typeof globalThis.fetch;
  rpcRequests: Array<{ body: unknown; headers: Record<string, string> }>;
} {
  const rpcRequests: Array<{ body: unknown; headers: Record<string, string> }> = [];
  let cursor = 0;
  const fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = typeof input === 'string' ? input : input.toString();
    if (url.endsWith('/agent-card.json') || url.endsWith('/agent.json')) {
      return agentCardResponse();
    }
    const headers: Record<string, string> = {};
    if (init?.headers) {
      const src = init.headers as Record<string, string>;
      for (const k of Object.keys(src)) headers[k.toLowerCase()] = src[k]!;
    }
    const body = init?.body
      ? JSON.parse(init.body as string)
      : undefined;
    rpcRequests.push({ body, headers });
    const make = replies[cursor];
    if (!make) {
      throw new Error(`No scripted reply for RPC call #${cursor + 1}`);
    }
    cursor += 1;
    return make();
  }) as unknown as typeof globalThis.fetch;
  return { fetch, rpcRequests };
}

describe('A2XClient.sendMessage — native x402 dance', () => {
  it('returns the first task untouched when the agent does not require payment', async () => {
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(completedTaskWithReceipt()),
    ]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: { signer: TEST_ACCOUNT },
    });
    const task = await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    });
    expect(task.status.state).toBe('completed');
    expect(rpcRequests).toHaveLength(1);
  });

  it('detects payment-required, signs, resubmits, and surfaces the settled task', async () => {
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(paymentRequiredTask()),
      () => jsonRpcOk(completedTaskWithReceipt()),
    ]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: { signer: TEST_ACCOUNT },
    });
    const task = await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    });

    expect(task.status.state).toBe('completed');
    expect(rpcRequests).toHaveLength(2);

    // Both calls carry the activation header.
    expect(rpcRequests[0]!.headers['x-a2a-extensions']).toBe(X402_EXTENSION_URI);
    expect(rpcRequests[1]!.headers['x-a2a-extensions']).toBe(X402_EXTENSION_URI);

    // Followup carries the signed payload + same taskId/contextId.
    const followupParams = (rpcRequests[1]!.body as { params: { message: Record<string, unknown> } }).params;
    expect(followupParams.message.taskId).toBe('t1');
    expect(followupParams.message.contextId).toBe('c1');
    const meta = followupParams.message.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.STATUS]).toBe(X402_PAYMENT_STATUS.SUBMITTED);
    expect(meta[X402_METADATA_KEYS.PAYLOAD]).toBeDefined();
  });

  it('throws X402PaymentFailedError when the settle receipt is unsuccessful', async () => {
    const { fetch } = scriptedFetch([
      () => jsonRpcOk(paymentRequiredTask()),
      () =>
        jsonRpcOk(
          failedTaskWithReceipt('insufficient_funds', 'INSUFFICIENT_FUNDS'),
        ),
    ]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: { signer: TEST_ACCOUNT },
    });
    await expect(
      client.sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
      }),
    ).rejects.toBeInstanceOf(X402PaymentFailedError);
  });

  it('invokes onPaymentRequired before signing and aborts when it throws', async () => {
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(paymentRequiredTask()),
    ]);
    const onPaymentRequired = vi.fn().mockImplementation(() => {
      throw new Error('user declined');
    });
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: { signer: TEST_ACCOUNT, onPaymentRequired },
    });
    await expect(
      client.sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
      }),
    ).rejects.toThrow('user declined');
    expect(onPaymentRequired).toHaveBeenCalledTimes(1);
    expect(rpcRequests).toHaveLength(1); // never reached the followup
  });

  it('rejects with X402NoSupportedRequirementError when every accept exceeds maxAmount', async () => {
    const { fetch } = scriptedFetch([
      () => jsonRpcOk(paymentRequiredTask()),
    ]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: { signer: TEST_ACCOUNT, maxAmount: 100n }, // requirement is 1000
    });
    await expect(
      client.sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
      }),
    ).rejects.toBeInstanceOf(X402NoSupportedRequirementError);
  });

  it('honours a caller-supplied selectRequirement', async () => {
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(paymentRequiredTask()),
      () => jsonRpcOk(completedTaskWithReceipt()),
    ]);
    const selectRequirement = vi.fn().mockImplementation((reqs) => reqs[0]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: { signer: TEST_ACCOUNT, selectRequirement },
    });
    await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    });
    expect(selectRequirement).toHaveBeenCalledTimes(1);
    expect(rpcRequests).toHaveLength(2);
  });

  it('does not run the dance when no x402 option is configured', async () => {
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(paymentRequiredTask()),
    ]);
    const client = new A2XClient(AGENT_URL, { fetch });
    const task = await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    });
    expect(task.status.state).toBe('input-required');
    expect(rpcRequests).toHaveLength(1);
    expect(rpcRequests[0]!.headers['x-a2a-extensions']).toBeUndefined();
  });

  it('sends payment-rejected when onPaymentRequired returns false (spec §5.4.2)', async () => {
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(paymentRequiredTask()),
      () =>
        jsonRpcOk({
          kind: 'task',
          id: 't1',
          contextId: 'c1',
          status: {
            state: 'failed',
            timestamp: new Date().toISOString(),
            message: {
              messageId: 'rj',
              role: 'agent',
              parts: [{ kind: 'text', text: 'declined' }],
              metadata: {
                [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REJECTED,
              },
            },
          },
          artifacts: [],
          history: [],
        }),
    ]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: { signer: TEST_ACCOUNT, onPaymentRequired: () => false },
    });
    const task = await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    });
    expect(task.status.state).toBe('failed');
    expect(rpcRequests).toHaveLength(2);
    const followup = (rpcRequests[1]!.body as { params: { message: { metadata: Record<string, unknown> } } }).params;
    expect(followup.message.metadata[X402_METADATA_KEYS.STATUS]).toBe(
      X402_PAYMENT_STATUS.REJECTED,
    );
    // Reject path must NOT send a signed payload — the merchant only
    // gets the rejection marker on the same task.
    expect(followup.message.metadata[X402_METADATA_KEYS.PAYLOAD]).toBeUndefined();
  });

  it('does not throw when the latest receipt is success despite historical failures (issue #143.4)', async () => {
    // Caller resumes a task that previously had a failed attempt. The
    // receipts array carries the complete history per spec §7. A
    // `find(!r.success)` scan would falsely throw on the stale failure
    // even though the most recent receipt is success.
    const { fetch } = scriptedFetch([
      () => jsonRpcOk(paymentRequiredTask()),
      () =>
        jsonRpcOk({
          kind: 'task',
          id: 't1',
          contextId: 'c1',
          status: {
            state: 'completed',
            timestamp: new Date().toISOString(),
            message: {
              messageId: 'final',
              role: 'agent',
              parts: [{ kind: 'text', text: 'ok' }],
              metadata: {
                [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.COMPLETED,
                [X402_METADATA_KEYS.RECEIPTS]: [
                  { success: false, transaction: '', network: 'base-sepolia', payer: '0xpayer', errorReason: 'old' },
                  { success: true, transaction: '0xabc', network: 'base-sepolia', payer: '0xpayer' },
                ],
              },
            },
          },
          artifacts: [],
          history: [],
        }),
    ]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: { signer: TEST_ACCOUNT },
    });
    const task = await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    });
    expect(task.status.state).toBe('completed');
  });

  it('surfaces a server-side retry signal (input-required + payment-required) without throwing', async () => {
    // `retryOnFailure: true` on the executor re-issues `payment-required`
    // after a failed verify/settle. The default client (maxRetries: 0)
    // signs once, sees the retry prompt, and surfaces the task — does
    // not throw on the failure receipt that came along for the ride.
    const retryTask = {
      kind: 'task',
      id: 't1',
      contextId: 'c1',
      status: {
        state: 'input-required',
        timestamp: new Date().toISOString(),
        message: {
          messageId: 'retry',
          role: 'agent',
          parts: [{ kind: 'text', text: 'try again' }],
          metadata: {
            [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
            [X402_METADATA_KEYS.REQUIRED]: {
              x402Version: 1,
              accepts: [
                {
                  scheme: 'exact',
                  network: 'base-sepolia',
                  maxAmountRequired: '1000',
                  resource: 'https://example.com/protected',
                  description: 'Per-call',
                  mimeType: 'application/json',
                  payTo: '0x000000000000000000000000000000000000dEaD',
                  maxTimeoutSeconds: 300,
                  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                  extra: { name: 'USDC', version: '2' },
                },
              ],
              error: 'insufficient_balance',
            },
            [X402_METADATA_KEYS.ERROR]: 'INSUFFICIENT_FUNDS',
            [X402_METADATA_KEYS.RECEIPTS]: [
              { success: false, transaction: '', network: 'base-sepolia', payer: '0xpayer', errorReason: 'insufficient_balance' },
            ],
          },
        },
      },
      artifacts: [],
      history: [],
    };
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(paymentRequiredTask()),
      () => jsonRpcOk(retryTask),
    ]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: { signer: TEST_ACCOUNT },
    });
    const task = await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    });
    expect(task.status.state).toBe('input-required');
    expect(rpcRequests).toHaveLength(2);
  });

  it('auto-retries up to maxRetries times when the server keeps re-issuing payment-required', async () => {
    const retryTask = (): unknown => ({
      kind: 'task',
      id: 't1',
      contextId: 'c1',
      status: {
        state: 'input-required',
        timestamp: new Date().toISOString(),
        message: {
          messageId: 'retry',
          role: 'agent',
          parts: [{ kind: 'text', text: 'try again' }],
          metadata: {
            [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
            [X402_METADATA_KEYS.REQUIRED]: {
              x402Version: 1,
              accepts: [
                {
                  scheme: 'exact',
                  network: 'base-sepolia',
                  maxAmountRequired: '1000',
                  resource: 'https://example.com/protected',
                  description: 'Per-call',
                  mimeType: 'application/json',
                  payTo: '0x000000000000000000000000000000000000dEaD',
                  maxTimeoutSeconds: 300,
                  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                  extra: { name: 'USDC', version: '2' },
                },
              ],
              error: 'transient',
            },
          },
        },
      },
      artifacts: [],
      history: [],
    });
    // initial → first sign → retry-required → second sign → completed
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(paymentRequiredTask()),
      () => jsonRpcOk(retryTask()),
      () => jsonRpcOk(completedTaskWithReceipt()),
    ]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: { signer: TEST_ACCOUNT, maxRetries: 1 },
    });
    const task = await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    });
    expect(task.status.state).toBe('completed');
    expect(rpcRequests).toHaveLength(3);
    // Both follow-ups must carry signed payload metadata, not the same
    // signature reused — fresh nonce per attempt is the whole point of
    // retry-on-failure.
    const followup1 = (rpcRequests[1]!.body as { params: { message: { metadata: Record<string, unknown> } } }).params.message.metadata;
    const followup2 = (rpcRequests[2]!.body as { params: { message: { metadata: Record<string, unknown> } } }).params.message.metadata;
    expect(followup1[X402_METADATA_KEYS.STATUS]).toBe(X402_PAYMENT_STATUS.SUBMITTED);
    expect(followup2[X402_METADATA_KEYS.STATUS]).toBe(X402_PAYMENT_STATUS.SUBMITTED);
  });
});

describe('A2XClient.sendMessageStream — native x402 dance', () => {
  function sseResponse(events: string[]): Response {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const ev of events) {
          controller.enqueue(encoder.encode(`data: ${ev}\n\n`));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }

  function statusUpdate(
    state: string,
    metadata: Record<string, unknown> | undefined,
    final: boolean,
  ): string {
    return JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      result: {
        kind: 'status-update',
        taskId: 't1',
        contextId: 'c1',
        status: {
          state,
          timestamp: new Date().toISOString(),
          ...(metadata
            ? {
                message: {
                  messageId: `m-${state}`,
                  role: 'agent',
                  parts: [{ kind: 'text', text: state }],
                  metadata,
                },
              }
            : {}),
        },
        final,
      },
    });
  }

  it('yields payment-required, signs, opens the followup stream, and yields completion', async () => {
    const firstStream = sseResponse([
      statusUpdate(
        'input-required',
        {
          [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
          [X402_METADATA_KEYS.REQUIRED]: {
            x402Version: 1,
            accepts: [
              {
                scheme: 'exact',
                network: 'base-sepolia',
                maxAmountRequired: '1000',
                resource: 'https://example.com/protected',
                description: 'Per-call',
                mimeType: 'application/json',
                payTo: '0x000000000000000000000000000000000000dEaD',
                maxTimeoutSeconds: 300,
                asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                extra: { name: 'USDC', version: '2' },
              },
            ],
          },
        },
        true,
      ),
    ]);
    const secondStream = sseResponse([
      statusUpdate(
        'working',
        { [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.VERIFIED },
        false,
      ),
      statusUpdate(
        'completed',
        {
          [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.COMPLETED,
          [X402_METADATA_KEYS.RECEIPTS]: [
            { success: true, transaction: '0xabc', network: 'base-sepolia', payer: '0x9999999999999999999999999999999999999999' },
          ],
        },
        true,
      ),
    ]);

    let call = 0;
    const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/agent-card.json') || url.endsWith('/agent.json')) {
        return agentCardResponse();
      }
      call += 1;
      if (call === 1) return firstStream;
      if (call === 2) return secondStream;
      throw new Error('Unexpected RPC call');
    }) as unknown as typeof globalThis.fetch;

    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: { signer: TEST_ACCOUNT },
    });

    const events: Array<Record<string, unknown>> = [];
    for await (const ev of client.sendMessageStream({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    })) {
      events.push(ev as unknown as Record<string, unknown>);
    }

    const states = events
      .filter((e) => 'status' in e)
      .map((e) => {
        const status = e.status as { state: string; message?: { metadata?: Record<string, unknown> } };
        return {
          state: status.state,
          x402: status.message?.metadata?.[X402_METADATA_KEYS.STATUS],
        };
      });

    // Expect: payment-required → payment-verified → payment-completed
    expect(states).toEqual([
      { state: 'input-required', x402: X402_PAYMENT_STATUS.REQUIRED },
      { state: 'working', x402: X402_PAYMENT_STATUS.VERIFIED },
      { state: 'completed', x402: X402_PAYMENT_STATUS.COMPLETED },
    ]);
    expect(call).toBe(2);
  });

  it('passes through events untouched when no x402 option is configured', async () => {
    const stream = sseResponse([
      statusUpdate('completed', undefined, true),
    ]);
    const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/agent-card.json') || url.endsWith('/agent.json')) {
        return agentCardResponse();
      }
      return stream;
    }) as unknown as typeof globalThis.fetch;

    const client = new A2XClient(AGENT_URL, { fetch });
    const events: unknown[] = [];
    for await (const ev of client.sendMessageStream({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    })) {
      events.push(ev);
    }
    expect(events).toHaveLength(1);
  });
});
