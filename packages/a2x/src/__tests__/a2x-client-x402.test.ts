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
import {
  A2XClient,
  type A2XClientX402Options,
} from '../client/a2x-client.js';
import {
  X402_EXTENSION_URI,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
} from '../x402/constants.js';
import type { Task } from '../types/task.js';
import { reconcileX402BatchSettlement } from '../x402/client.js';
import {
  X402NoSupportedRequirementError,
  X402PaymentFailedError,
  X402ReconciliationError,
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

/** A V2 `payment-required` whose only option is a usage-based `upto` offer. */
function uptoRequiredTask(): unknown {
  return {
    kind: 'task',
    id: 't1',
    contextId: 'c1',
    status: {
      state: 'input-required',
      timestamp: new Date().toISOString(),
      message: {
        messageId: 'x402-upto-1',
        role: 'agent',
        parts: [{ kind: 'text', text: 'pay up to' }],
        metadata: {
          [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
          [X402_METADATA_KEYS.REQUIRED]: {
            x402Version: 2,
            resource: { url: 'https://example.com/protected' },
            accepts: [
              {
                scheme: 'upto',
                network: 'eip155:84532',
                asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                amount: '1000',
                payTo: '0x000000000000000000000000000000000000dEaD',
                maxTimeoutSeconds: 300,
                extra: {
                  facilitatorAddress:
                    '0x4444444444444444444444444444444444444444',
                },
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
function scriptedFetch(
  replies: Array<
    (
      rpcRequests: Array<{
        body: unknown;
        headers: Record<string, string>;
      }>,
    ) => Response
  >,
): {
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
    return make(rpcRequests);
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

  it('does not sign an upto-only offer unless allowUpto is set', async () => {
    const { fetch } = scriptedFetch([() => jsonRpcOk(uptoRequiredTask())]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: { signer: TEST_ACCOUNT },
    });
    await expect(
      client.sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
      }),
    ).rejects.toBeInstanceOf(X402NoSupportedRequirementError);
  });

  it('signs an upto-only offer when allowUpto is set', async () => {
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(uptoRequiredTask()),
      () => jsonRpcOk(completedTaskWithReceipt()),
    ]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: { signer: TEST_ACCOUNT, allowUpto: true },
    });
    const task = await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    });

    expect(task.status.state).toBe('completed');
    expect(rpcRequests).toHaveLength(2);
    const followup = rpcRequests[1]!.body as {
      params: { message: { metadata: Record<string, unknown> } };
    };
    const meta = followup.params.message.metadata;
    expect(meta[X402_METADATA_KEYS.STATUS]).toBe(X402_PAYMENT_STATUS.SUBMITTED);
    const payload = meta[X402_METADATA_KEYS.PAYLOAD] as {
      payload: { permit2Authorization: { from: string } };
    };
    // A real Permit2 witness, signed by the configured account.
    expect(payload.payload.permit2Authorization.from.toLowerCase()).toBe(
      TEST_ACCOUNT.address.toLowerCase(),
    );
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

describe('A2XClient.sendMessage — batch-settlement', () => {
  /** A channel id the payer never signed, used to test the binding. */
  const FOREIGN_CHANNEL_ID = `0x${'cd'.repeat(32)}`;

  /**
   * Channel id out of the payload the client submitted, as a real merchant
   * would echo it. Reconciliation is bound to the channel the payer actually
   * signed, so the fixture cannot invent one.
   */
  function signedChannelId(
    rpcRequests: Array<{ body: unknown }>,
  ): string {
    const submission = rpcRequests.at(-1)!.body as {
      params: { message: { metadata: Record<string, unknown> } };
    };
    const payload = submission.params.message.metadata[
      X402_METADATA_KEYS.PAYLOAD
    ] as { payload: { voucher: { channelId: string } } };
    return payload.payload.voucher.channelId;
  }

  /** A V2 `payment-required` whose only option is a `batch-settlement` offer. */
  function batchRequiredTask(): unknown {
    return {
      kind: 'task',
      id: 't1',
      contextId: 'c1',
      status: {
        state: 'input-required',
        timestamp: new Date().toISOString(),
        message: {
          messageId: 'x402-batch-1',
          role: 'agent',
          parts: [{ kind: 'text', text: 'open a channel' }],
          metadata: {
            [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
            [X402_METADATA_KEYS.REQUIRED]: {
              x402Version: 2,
              resource: { url: 'https://example.com/protected' },
              accepts: [
                {
                  scheme: 'batch-settlement',
                  network: 'eip155:84532',
                  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
                  amount: '1000',
                  payTo: '0x000000000000000000000000000000000000dEaD',
                  maxTimeoutSeconds: 300,
                  extra: {
                    name: 'USDC',
                    version: '2',
                    receiverAuthorizer:
                      '0x5555555555555555555555555555555555555555',
                  },
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

  /** Terminal task carrying the merchant's post-voucher channel snapshot. */
  function completedTaskWithChannelReceipt(
    channelId: string,
    chargedCumulativeAmount = '1000',
  ): unknown {
    return {
      kind: 'task',
      id: 't1',
      contextId: 'c1',
      status: {
        state: 'completed',
        timestamp: new Date().toISOString(),
        message: {
          messageId: 'x402-batch-2',
          role: 'agent',
          parts: [{ kind: 'text', text: 'done' }],
          metadata: {
            [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.COMPLETED,
            [X402_METADATA_KEYS.RECEIPTS]: [
              {
                success: true,
                // Voucher settlements never carry a tx hash.
                transaction: '',
                network: 'eip155:84532',
                extra: {
                  channelState: {
                    channelId,
                    balance: '5000',
                    totalClaimed: '0',
                    chargedCumulativeAmount,
                  },
                },
              },
            ],
          },
        },
      },
      artifacts: [],
      history: [],
    };
  }

  /** Contradictory response: the voucher succeeded, but payment is requested again. */
  function retryTaskWithChannelReceipt(channelId: string): unknown {
    const task = completedTaskWithChannelReceipt(channelId) as {
      status: {
        state: string;
        message: { metadata: Record<string, unknown> };
      };
    };
    const required = batchRequiredTask() as {
      status: { message: { metadata: Record<string, unknown> } };
    };
    task.status.state = 'input-required';
    task.status.message.metadata[X402_METADATA_KEYS.STATUS] =
      X402_PAYMENT_STATUS.REQUIRED;
    task.status.message.metadata[X402_METADATA_KEYS.REQUIRED] =
      required.status.message.metadata[X402_METADATA_KEYS.REQUIRED];
    return task;
  }

  function batchSse(events: unknown[]): Response {
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(controller) {
          for (const event of events) {
            controller.enqueue(
              encoder.encode(
                `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: event })}\n\n`,
              ),
            );
          }
          controller.close();
        },
      }),
      { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
    );
  }

  function batchStatusEvent(state: string, message: unknown) {
    return {
      kind: 'status-update',
      taskId: 't1',
      contextId: 'c1',
      status: { state, timestamp: new Date().toISOString(), message },
      final: false,
    };
  }

  function channelStorage() {
    const channels = new Map<string, Record<string, unknown>>();
    return {
      channels,
      storage: {
        get: async (key: string) => channels.get(key),
        set: async (key: string, state: Record<string, unknown>) => {
          channels.set(key, state);
        },
        delete: async (key: string) => {
          channels.delete(key);
        },
      },
    };
  }

  it('signs a batch-settlement offer and folds the receipt back into channel storage', async () => {
    const { channels, storage } = channelStorage();
    // The reply thunk runs after the submission is recorded, so it can echo
    // the channel the client actually signed — `recorded` is bound to the
    // live array below before any request is made.
    let recorded: Array<{ body: unknown }> = [];
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(batchRequiredTask()),
      () => jsonRpcOk(completedTaskWithChannelReceipt(signedChannelId(recorded))),
    ]);
    recorded = rpcRequests;
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
      },
    });

    const task = await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    });
    expect(task.status.state).toBe('completed');
    expect(rpcRequests).toHaveLength(2);

    // No local channel existed, so the first payload funds one: an ERC-3009
    // deposit bundled with the opening voucher, not a bare voucher.
    const followup = (
      rpcRequests[1]!.body as {
        params: { message: { metadata: Record<string, unknown> } };
      }
    ).params.message.metadata;
    const payload = followup[X402_METADATA_KEYS.PAYLOAD] as {
      accepted: { scheme: string };
      payload: { type: string; deposit: { amount: string } };
    };
    expect(payload.accepted.scheme).toBe('batch-settlement');
    expect(payload.payload.type).toBe('deposit');
    // Default policy funds 5x the request amount, so one deposit covers the
    // next four calls as pure vouchers.
    expect(payload.payload.deposit.amount).toBe('5000');

    // The reconcile step is what makes the *next* call a cheap voucher instead
    // of a second deposit — without it the payer re-funds the same channel
    // forever, since a LocalAccount cannot read the channel back off-chain.
    expect(channels.get(signedChannelId(rpcRequests).toLowerCase())).toEqual({
      balance: '5000',
      totalClaimed: '0',
      chargedCumulativeAmount: '1000',
    });
  });

  it('serializes concurrent batch attempts until the first receipt is reconciled', async () => {
    const { channels, storage } = channelStorage();
    const submitted: Array<{
      payload: {
        type: string;
        voucher: { channelId: string; maxClaimableAmount: string };
      };
    }> = [];
    let submissionCount = 0;
    let initialCount = 0;
    let resolveBothInitial!: () => void;
    const bothInitial = new Promise<void>((resolve) => {
      resolveBothInitial = resolve;
    });
    let resolveFirstSubmission!: () => void;
    const firstSubmission = new Promise<void>((resolve) => {
      resolveFirstSubmission = resolve;
    });
    let resolveSecondSubmission!: () => void;
    const secondSubmission = new Promise<void>((resolve) => {
      resolveSecondSubmission = resolve;
    });
    let releaseFirstResponse!: () => void;
    const firstResponseGate = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });

    const fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/agent-card.json') || url.endsWith('/agent.json')) {
        return agentCardResponse();
      }
      const body = init?.body
        ? (JSON.parse(init.body as string) as {
            params?: { message?: { metadata?: Record<string, unknown> } };
          })
        : undefined;
      const payment = body?.params?.message?.metadata?.[
        X402_METADATA_KEYS.PAYLOAD
      ] as (typeof submitted)[number] | undefined;
      if (!payment) {
        initialCount += 1;
        if (initialCount === 2) resolveBothInitial();
        return jsonRpcOk(batchRequiredTask());
      }

      submitted.push(payment);
      submissionCount += 1;
      if (submissionCount === 1) {
        resolveFirstSubmission();
        await firstResponseGate;
      } else {
        resolveSecondSubmission();
      }
      return jsonRpcOk(
        completedTaskWithChannelReceipt(
          payment.payload.voucher.channelId,
          payment.payload.voucher.maxClaimableAmount,
        ),
      );
    }) as unknown as typeof globalThis.fetch;
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
      },
    });

    const calls = Promise.all([
      client.sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'one' }] },
      }),
      client.sendMessage({
        message: { messageId: 'm2', role: 'user', parts: [{ text: 'two' }] },
      }),
    ]);
    await Promise.all([bothInitial, firstSubmission]);
    const overlapped = await Promise.race([
      secondSubmission.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 100)),
    ]);
    releaseFirstResponse();
    await calls;

    expect(overlapped).toBe(false);
    expect(submitted).toHaveLength(2);
    expect(submitted[0]!.payload.type).toBe('deposit');
    expect(submitted[0]!.payload.voucher.maxClaimableAmount).toBe('1000');
    expect(submitted[1]!.payload.type).toBe('voucher');
    expect(submitted[1]!.payload.voucher.maxClaimableAmount).toBe('2000');
    expect(
      channels.get(submitted[0]!.payload.voucher.channelId.toLowerCase()),
    ).toMatchObject({
      balance: '5000',
      chargedCumulativeAmount: '2000',
    });
  });

  it('aborts queued batch attempts when the predecessor is quarantined', async () => {
    const { channels, storage } = channelStorage();
    const submitted: Array<{
      payload: {
        type: string;
        voucher: { channelId: string; maxClaimableAmount: string };
      };
    }> = [];
    let selectedCount = 0;
    let resolveBothSelected!: () => void;
    const bothSelected = new Promise<void>((resolve) => {
      resolveBothSelected = resolve;
    });
    let resolveFirstSubmission!: () => void;
    const firstSubmission = new Promise<void>((resolve) => {
      resolveFirstSubmission = resolve;
    });
    let releaseFirstResponse!: () => void;
    const firstResponseGate = new Promise<void>((resolve) => {
      releaseFirstResponse = resolve;
    });

    const fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/agent-card.json') || url.endsWith('/agent.json')) {
        return agentCardResponse();
      }
      const body = init?.body
        ? (JSON.parse(init.body as string) as {
            params?: { message?: { metadata?: Record<string, unknown> } };
          })
        : undefined;
      const payment = body?.params?.message?.metadata?.[
        X402_METADATA_KEYS.PAYLOAD
      ] as (typeof submitted)[number] | undefined;
      if (!payment) return jsonRpcOk(batchRequiredTask());

      submitted.push(payment);
      resolveFirstSubmission();
      await firstResponseGate;
      const task = completedTaskWithChannelReceipt(
        payment.payload.voucher.channelId,
        payment.payload.voucher.maxClaimableAmount,
      ) as {
        status: { message: { metadata: Record<string, unknown> } };
      };
      delete task.status.message.metadata[X402_METADATA_KEYS.RECEIPTS];
      return jsonRpcOk(task);
    }) as unknown as typeof globalThis.fetch;
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        selectRequirement: (requirements) => {
          selectedCount += 1;
          if (selectedCount === 2) resolveBothSelected();
          return requirements[0];
        },
      },
    });

    const calls = Promise.allSettled([
      client.sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'one' }] },
      }),
      client.sendMessage({
        message: { messageId: 'm2', role: 'user', parts: [{ text: 'two' }] },
      }),
    ]);
    await Promise.all([bothSelected, firstSubmission]);
    expect(submitted).toHaveLength(1);
    releaseFirstResponse();
    const outcomes = await calls;

    expect(submitted).toHaveLength(1);
    expect(channels.size).toBe(0);
    expect(outcomes).toHaveLength(2);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe('rejected');
      if (outcome.status === 'rejected') {
        expect(outcome.reason).toBeInstanceOf(X402ReconciliationError);
        expect((outcome.reason as X402ReconciliationError).reason).toBe(
          'no-matching-receipt',
        );
      }
    }
  });

  it('reconciles through the storage snapshot used to sign the attempt', async () => {
    const storageAState = channelStorage();
    const storageBState = channelStorage();
    const storageA = {
      ...storageAState.storage,
      get: async (key: string) =>
        storageAState.channels.get(key) ?? {
          balance: '5000',
          chargedCumulativeAmount: '1000',
          totalClaimed: '0',
        },
    };
    let x402!: A2XClientX402Options;
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(batchRequiredTask()),
      (requests) => {
        const task = completedTaskWithChannelReceipt(
          signedChannelId(requests),
          '2000',
        ) as {
          status: { message: { metadata: Record<string, unknown> } };
        };
        const receipts = task.status.message.metadata[
          X402_METADATA_KEYS.RECEIPTS
        ] as Array<{ extra: { channelState: { balance?: string } } }>;
        delete receipts[0]!.extra.channelState.balance;
        x402.batchSettlement = { storage: storageBState.storage };
        return jsonRpcOk(task);
      },
    ]);
    x402 = {
      signer: TEST_ACCOUNT,
      batchSettlement: { storage: storageA },
      allowBatchSettlement: true,
    };
    const client = new A2XClient(AGENT_URL, { fetch, x402 });

    await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    });

    expect(
      storageAState.channels.get(signedChannelId(rpcRequests).toLowerCase()),
    ).toMatchObject({
      balance: '5000',
      chargedCumulativeAmount: '2000',
    });
    expect(storageBState.channels.size).toBe(0);
  });

  it('does not retry a batch payment after applying its success receipt', async () => {
    const { channels, storage } = channelStorage();
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(batchRequiredTask()),
      (requests) =>
        jsonRpcOk(retryTaskWithChannelReceipt(signedChannelId(requests))),
    ]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
        maxRetries: 1,
      },
    });

    const task = await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    });

    expect(task.status.state).toBe('input-required');
    expect(rpcRequests).toHaveLength(2);
    expect(channels.get(signedChannelId(rpcRequests).toLowerCase())).toMatchObject({
      balance: '5000',
      chargedCumulativeAmount: '1000',
    });
  });

  it('does not select a batch-settlement offer without allowBatchSettlement', async () => {
    const { storage } = channelStorage();
    const { fetch } = scriptedFetch([() => jsonRpcOk(batchRequiredTask())]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: { signer: TEST_ACCOUNT, batchSettlement: { storage } },
    });
    await expect(
      client.sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
      }),
    ).rejects.toThrow(X402NoSupportedRequirementError);
  });

  it('reconciles over streaming even when the consumer breaks on the final event', async () => {
    // Regression guard. The receipt rides the final status event, and the
    // idiomatic consumer breaks out of its loop right there — which calls the
    // generator's return() at the suspended yield. Reconciling *after* the
    // yield would never run, and the next call would sign a second real
    // deposit into an already-funded channel.
    const { channels, storage } = channelStorage();
    const encoder = new TextEncoder();
    const sse = (events: unknown[]) =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const ev of events) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: ev })}\n\n`,
                ),
              );
            }
            controller.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );

    const required = batchRequiredTask() as {
      status: { message: { metadata: Record<string, unknown> } };
    };
    const statusEvent = (
      state: string,
      message: unknown,
      final: boolean,
    ) => ({
      kind: 'status-update',
      taskId: 't1',
      contextId: 'c1',
      status: { state, timestamp: new Date().toISOString(), message },
      final,
    });

    let call = 0;
    const recorded: Array<{ body: unknown }> = [];
    const fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/agent-card.json') || url.endsWith('/agent.json')) {
        return agentCardResponse();
      }
      recorded.push({ body: init?.body ? JSON.parse(init.body as string) : undefined });
      if (call++ === 0) {
        return sse([
          statusEvent('input-required', required.status.message, false),
        ]);
      }
      // Echo the channel the client actually signed, as a merchant would.
      const completed = completedTaskWithChannelReceipt(
        signedChannelId(recorded),
      ) as { status: { message: unknown } };
      return sse([statusEvent('completed', completed.status.message, true)]);
    }) as unknown as typeof globalThis.fetch;

    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
      },
    });

    for await (const event of client.sendMessageStream({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    })) {
      // Exactly the pattern that used to lose the receipt.
      if ('status' in event && event.status?.state === 'completed') break;
    }

    expect(channels.get(signedChannelId(recorded).toLowerCase())).toEqual({
      balance: '5000',
      totalClaimed: '0',
      chargedCumulativeAmount: '1000',
    });
  });

  it('does not retry a streamed batch payment after applying its success receipt', async () => {
    const { channels, storage } = channelStorage();
    const required = batchRequiredTask() as {
      status: { message: unknown };
    };
    const { fetch, rpcRequests } = scriptedFetch([
      () =>
        batchSse([
          batchStatusEvent('input-required', required.status.message),
        ]),
      (requests) => {
        const retry = retryTaskWithChannelReceipt(signedChannelId(requests)) as {
          status: { message: unknown };
        };
        return batchSse([
          batchStatusEvent('input-required', retry.status.message),
        ]);
      },
    ]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
        maxRetries: 1,
      },
    });

    const states: string[] = [];
    for await (const event of client.sendMessageStream({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    })) {
      if ('status' in event) states.push(event.status!.state as string);
    }

    expect(states).toEqual(['input-required', 'input-required']);
    expect(rpcRequests).toHaveLength(2);
    expect(channels.get(signedChannelId(rpcRequests).toLowerCase())).toMatchObject({
      balance: '5000',
      chargedCumulativeAmount: '1000',
    });
  });

  it('does not retry when a later stream event contradicts an applied receipt', async () => {
    const { channels, storage } = channelStorage();
    const required = batchRequiredTask() as {
      status: { message: unknown };
    };
    const { fetch, rpcRequests } = scriptedFetch([
      () =>
        batchSse([
          batchStatusEvent('input-required', required.status.message),
        ]),
      (requests) => {
        const completed = completedTaskWithChannelReceipt(
          signedChannelId(requests),
        ) as { status: { message: unknown } };
        return batchSse([
          batchStatusEvent('working', completed.status.message),
          batchStatusEvent('input-required', required.status.message),
        ]);
      },
    ]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
        maxRetries: 1,
      },
    });

    const states: string[] = [];
    for await (const event of client.sendMessageStream({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    })) {
      if ('status' in event) states.push(event.status!.state as string);
    }

    expect(states).toEqual(['input-required', 'working', 'input-required']);
    expect(rpcRequests).toHaveLength(2);
    expect(channels.get(signedChannelId(rpcRequests).toLowerCase())).toMatchObject({
      balance: '5000',
      chargedCumulativeAmount: '1000',
    });
  });

  it('quarantines a streamed batch payment on a marker-only retry response', async () => {
    const { channels, storage } = channelStorage();
    const required = batchRequiredTask() as {
      status: { message: unknown };
    };
    const markerOnlyMessage = {
      messageId: 'x402-batch-retry',
      role: 'agent',
      parts: [{ kind: 'text', text: 'try again' }],
      metadata: {
        [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
      },
    };

    const { fetch, rpcRequests } = scriptedFetch([
      () =>
        batchSse([
          batchStatusEvent('input-required', required.status.message),
        ]),
      () =>
        batchSse([
          batchStatusEvent('input-required', markerOnlyMessage),
        ]),
    ]);
    const seen: X402ReconciliationError[] = [];
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
        onReconcileError: (error) => {
          seen.push(error);
        },
      },
    });

    const states: string[] = [];
    for await (const event of client.sendMessageStream({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    })) {
      if ('status' in event) states.push(event.status!.state as string);
    }

    expect(states).toEqual(['input-required', 'input-required']);
    expect(rpcRequests).toHaveLength(2);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reason).toBe('ambiguous-response');
    expect(seen[0]!.channelId).toBe(signedChannelId(rpcRequests));
    expect(channels.size).toBe(0);
  });

  it('quarantines the channel when the consumer closes a paid stream early', async () => {
    const { channels, storage } = channelStorage();
    const encoder = new TextEncoder();
    const sse = (events: unknown[]) =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const event of events) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: event })}\n\n`,
                ),
              );
            }
            controller.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    const required = batchRequiredTask() as {
      status: { message: unknown };
    };
    const statusEvent = (state: string, message: unknown) => ({
      kind: 'status-update',
      taskId: 't1',
      contextId: 'c1',
      status: { state, timestamp: new Date().toISOString(), message },
      final: false,
    });
    const verifiedMessage = {
      messageId: 'x402-batch-2',
      role: 'agent',
      parts: [{ kind: 'text', text: 'payment verified' }],
      metadata: {
        [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.VERIFIED,
      },
    };

    let call = 0;
    const recorded: Array<{ body: unknown }> = [];
    const fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/agent-card.json') || url.endsWith('/agent.json')) {
        return agentCardResponse();
      }
      recorded.push({
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (call++ === 0) {
        return sse([statusEvent('input-required', required.status.message)]);
      }
      return sse([statusEvent('working', verifiedMessage)]);
    }) as unknown as typeof globalThis.fetch;
    const seen: X402ReconciliationError[] = [];
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
        onReconcileError: (error) => {
          seen.push(error);
        },
      },
    });

    for await (const event of client.sendMessageStream({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    })) {
      if ('status' in event && event.status?.state === 'working') break;
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]!.reason).toBe('ambiguous-response');
    expect(seen[0]!.channelId).toBe(signedChannelId(recorded));
    expect(seen[0]!.task).toBeUndefined();
    expect(channels.size).toBe(0);
  });

  it('ignores receipts from an exchange it did not pay with a voucher', async () => {
    // The storage key is the *merchant-supplied* channelId, and channel ids
    // derive from public inputs — so any agent could name the channel this
    // payer shares with a different merchant. Folding receipts from a task we
    // never paid would let it plant a bogus cumulative and brick that channel.
    const { channels, storage } = channelStorage();
    const { fetch } = scriptedFetch([
      () => jsonRpcOk(completedTaskWithChannelReceipt(FOREIGN_CHANNEL_ID)),
    ]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
      },
    });
    const task = await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    });
    expect(task.status.state).toBe('completed');
    expect(channels.size).toBe(0);
  });

  it('refuses a foreign channel write AND raises, since the voucher is spent', async () => {
    // The gate above stops agents we never paid. This is the other half: a
    // merchant we *did* pay must not be able to name someone else's channel —
    // ids are computable from public inputs, so it could brick a channel this
    // payer shares with a different merchant, or force an invalid top-up.
    //
    // Refusing the write is necessary but not sufficient: the voucher is
    // spent and our own channel state did not move, so the next call would
    // see no funded channel and sign a fresh real deposit. Swallowing that as
    // a completed task is the unsafe half.
    const { channels, storage } = channelStorage();
    const { fetch } = scriptedFetch([
      () => jsonRpcOk(batchRequiredTask()),
      () => jsonRpcOk(completedTaskWithChannelReceipt(FOREIGN_CHANNEL_ID)),
    ]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
      },
    });
    const error = await client
      .sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
      })
      .then(
        () => undefined,
        (e: unknown) => e as X402ReconciliationError,
      );
    expect(error).toBeInstanceOf(X402ReconciliationError);
    expect(error!.reason).toBe('no-matching-receipt');
    // Nothing foreign was written, and the caller still has its result.
    expect(channels.size).toBe(0);
    expect((error!.task as Task).status.state).toBe('completed');
  });

  it('preserves the paid result on a streaming reconciliation failure', async () => {
    // Reconciliation runs before the final event is yielded, so a throw means
    // the consumer never sees that event. The error must therefore carry a
    // task-shaped value or the result is lost outright — the blocking path
    // already did this; streaming passed `undefined`.
    const { storage } = channelStorage();
    const encoder = new TextEncoder();
    const sse = (events: unknown[]) =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const ev of events) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: ev })}\n\n`,
                ),
              );
            }
            controller.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    const required = batchRequiredTask() as {
      status: { message: { metadata: Record<string, unknown> } };
    };
    const statusEvent = (state: string, message: unknown, final: boolean) => ({
      kind: 'status-update',
      taskId: 't1',
      contextId: 'c1',
      status: { state, timestamp: new Date().toISOString(), message },
      final,
    });

    let call = 0;
    const recorded: Array<{ body: unknown }> = [];
    const fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/agent-card.json') || url.endsWith('/agent.json')) {
        return agentCardResponse();
      }
      recorded.push({
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (call++ === 0) {
        return sse([
          statusEvent('input-required', required.status.message, false),
        ]);
      }
      const completed = completedTaskWithChannelReceipt(
        signedChannelId(recorded),
      ) as { status: { message: unknown } };
      return sse([statusEvent('completed', completed.status.message, true)]);
    }) as unknown as typeof globalThis.fetch;

    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: {
          storage: {
            ...storage,
            set: async () => {
              throw new Error('durable store unavailable');
            },
          },
        },
        allowBatchSettlement: true,
      },
    });

    let caught: X402ReconciliationError | undefined;
    try {
      for await (const _event of client.sendMessageStream({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
      })) {
        // consume
      }
    } catch (err) {
      caught = err as X402ReconciliationError;
    }
    expect(caught).toBeInstanceOf(X402ReconciliationError);
    expect(caught!.reason).toBe('write-failed');
    // The task the consumer never got to see is on the error.
    expect((caught!.task as Task).status.state).toBe('completed');
    expect((caught!.task as Task).id).toBe('t1');
  });

  it('records the deposit even when the merchant reports it away', async () => {
    // End-to-end against the real `@x402/evm`. The merchant settles the
    // voucher but reports `balance: "0"`; if that survives, the next call sees
    // an unfunded channel and signs another real deposit — and `maxAmount`
    // would not stop it, since it caps deposits individually.
    const { channels, storage } = channelStorage();
    let recorded: Array<{ body: unknown }> = [];
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(batchRequiredTask()),
      () => {
        const task = completedTaskWithChannelReceipt(
          signedChannelId(recorded),
        ) as { status: { message: { metadata: Record<string, unknown> } } };
        const receipts = task.status.message.metadata[
          X402_METADATA_KEYS.RECEIPTS
        ] as Array<{ extra: { channelState: { balance: string } } }>;
        receipts[0]!.extra.channelState.balance = '0';
        return jsonRpcOk(task);
      },
    ]);
    recorded = rpcRequests;
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
      },
    });
    await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    });

    // Asserts the state after upstream's merge, not the input we handed it —
    // the peer assigns `balance` only when the receipt still carries the key,
    // so a guard that merely deleted it would leave this undefined.
    expect(channels.get(signedChannelId(rpcRequests).toLowerCase())).toMatchObject({
      balance: '5000',
      chargedCumulativeAmount: '1000',
    });
  });

  it('clears the batch binding when a streaming retry signs another scheme', async () => {
    // Under `retryOnFailure` a later attempt can select a different scheme.
    // Carrying the batch binding forward would test that attempt's `exact`
    // receipt against it and report a successful payment as unreconciled.
    const { storage } = channelStorage();
    const encoder = new TextEncoder();
    const sse = (events: unknown[]) =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const ev of events) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: ev })}\n\n`,
                ),
              );
            }
            controller.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    const statusEvent = (state: string, message: unknown, final: boolean) => ({
      kind: 'status-update',
      taskId: 't1',
      contextId: 'c1',
      status: { state, timestamp: new Date().toISOString(), message },
      final,
    });
    const batchRequired = batchRequiredTask() as {
      status: { message: unknown };
    };
    // Second prompt offers only `exact`, so the retry switches scheme.
    const exactRequired = paymentRequiredTask() as {
      status: { message: unknown };
    };
    const exactCompleted = completedTaskWithReceipt() as {
      status: { message: unknown };
    };

    let call = 0;
    const fetch = (async (input: RequestInfo | URL): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/agent-card.json') || url.endsWith('/agent.json')) {
        return agentCardResponse();
      }
      const streams = [
        sse([statusEvent('input-required', batchRequired.status.message, false)]),
        sse([statusEvent('input-required', exactRequired.status.message, false)]),
        sse([statusEvent('completed', exactCompleted.status.message, true)]),
      ];
      return streams[call++]!;
    }) as unknown as typeof globalThis.fetch;

    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
        maxRetries: 1,
      },
    });

    const states: string[] = [];
    for await (const event of client.sendMessageStream({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    })) {
      if ('status' in event) states.push(event.status!.state as string);
    }
    // The exact payment succeeded and must not be reported as unreconciled.
    expect(states.at(-1)).toBe('completed');
  });

  it('raises when a settled payment comes back with no receipt at all', async () => {
    const { storage } = channelStorage();
    const completedNoReceipt = () => {
      const task = completedTaskWithChannelReceipt(FOREIGN_CHANNEL_ID) as {
        status: { message: { metadata: Record<string, unknown> } };
      };
      delete task.status.message.metadata[X402_METADATA_KEYS.RECEIPTS];
      return task;
    };
    const { fetch } = scriptedFetch([
      () => jsonRpcOk(batchRequiredTask()),
      () => jsonRpcOk(completedNoReceipt()),
    ]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
      },
    });
    await expect(
      client.sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
      }),
    ).rejects.toBeInstanceOf(X402ReconciliationError);
  });

  it('raises when a completed task omits both the x402 status and receipt', async () => {
    // Once the merchant completes a task after receiving our voucher, the
    // voucher may be spent. Trusting the remote status marker as the only
    // settlement signal lets it suppress both keys and leave local state stale.
    const { storage } = channelStorage();
    const completedWithoutX402Metadata = () => {
      const task = completedTaskWithChannelReceipt(FOREIGN_CHANNEL_ID) as {
        status: { message: { metadata: Record<string, unknown> } };
      };
      delete task.status.message.metadata[X402_METADATA_KEYS.STATUS];
      delete task.status.message.metadata[X402_METADATA_KEYS.RECEIPTS];
      return task;
    };
    const { fetch } = scriptedFetch([
      () => jsonRpcOk(batchRequiredTask()),
      () => jsonRpcOk(completedWithoutX402Metadata()),
    ]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
      },
    });
    const error = await client
      .sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
      })
      .then(
        () => undefined,
        (reason: unknown) => reason as X402ReconciliationError,
      );
    expect(error).toBeInstanceOf(X402ReconciliationError);
    expect(error!.reason).toBe('no-matching-receipt');
  });

  it.each(['failed', 'canceled', 'rejected'])(
    'raises when a terminal %s task omits x402 metadata',
    async (state) => {
      const { storage } = channelStorage();
      const terminalWithoutX402Metadata = () => {
        const task = completedTaskWithChannelReceipt(FOREIGN_CHANNEL_ID) as {
          status: {
            state: string;
            message: { metadata: Record<string, unknown> };
          };
        };
        task.status.state = state;
        delete task.status.message.metadata[X402_METADATA_KEYS.STATUS];
        delete task.status.message.metadata[X402_METADATA_KEYS.RECEIPTS];
        return task;
      };
      const { fetch } = scriptedFetch([
        () => jsonRpcOk(batchRequiredTask()),
        () => jsonRpcOk(terminalWithoutX402Metadata()),
      ]);
      const client = new A2XClient(AGENT_URL, {
        fetch,
        x402: {
          signer: TEST_ACCOUNT,
          batchSettlement: { storage },
          allowBatchSettlement: true,
        },
      });
      const error = await client
        .sendMessage({
          message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
        })
        .then(
          () => undefined,
          (reason: unknown) => reason as X402ReconciliationError,
        );
      expect(error).toBeInstanceOf(X402ReconciliationError);
      expect(error!.reason).toBe('no-matching-receipt');
      expect((error!.task as Task).status.state).toBe(state);
    },
  );

  it('quarantines a submitted channel when the blocking response rejects', async () => {
    const { storage } = channelStorage();
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(batchRequiredTask()),
      () => {
        throw new Error('connection reset after submit');
      },
    ]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
      },
    });
    const error = await client
      .sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
      })
      .then(
        () => undefined,
        (reason: unknown) => reason as X402ReconciliationError,
      );
    expect(error).toBeInstanceOf(X402ReconciliationError);
    expect(error!.reason).toBe('ambiguous-response');
    expect(error!.channelId).toBe(signedChannelId(rpcRequests));
    expect(error!.task).toBeUndefined();
    expect((error as Error & { cause?: unknown }).cause).toEqual(
      new Error('connection reset after submit'),
    );
  });

  it('quarantines a non-terminal unary response after batch submission', async () => {
    const { channels, storage } = channelStorage();
    const working = batchRequiredTask() as {
      status: {
        state: string;
        message: { metadata: Record<string, unknown> };
      };
    };
    working.status.state = 'working';
    working.status.message.metadata = {
      [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.VERIFIED,
    };
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(batchRequiredTask()),
      () => jsonRpcOk(working),
    ]);
    const seen: X402ReconciliationError[] = [];
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
        onReconcileError: (error) => {
          seen.push(error);
        },
      },
    });

    const task = await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
      configuration: { blocking: false },
    });

    expect(task.status.state).toBe('working');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.reason).toBe('ambiguous-response');
    expect(seen[0]!.channelId).toBe(signedChannelId(rpcRequests));
    expect((seen[0]!.task as Task).status.state).toBe('working');
    expect(channels.size).toBe(0);
  });

  it.each(['error', 'eof'])('quarantines a submitted channel on streaming %s', async (ending) => {
    const { storage } = channelStorage();
    const encoder = new TextEncoder();
    const sse = (events: unknown[]) =>
      new Response(
        new ReadableStream({
          start(controller) {
            for (const event of events) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: event })}\n\n`,
                ),
              );
            }
            controller.close();
          },
        }),
        { status: 200, headers: { 'Content-Type': 'text/event-stream' } },
      );
    const required = batchRequiredTask() as {
      status: { message: unknown };
    };
    const requiredEvent = {
      kind: 'status-update',
      taskId: 't1',
      contextId: 'c1',
      status: {
        state: 'input-required',
        timestamp: new Date().toISOString(),
        message: required.status.message,
      },
      final: false,
    };

    let call = 0;
    const rpcRequests: Array<{ body: unknown }> = [];
    const fetch = (async (
      input: RequestInfo | URL,
      init?: RequestInit,
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/agent-card.json') || url.endsWith('/agent.json')) {
        return agentCardResponse();
      }
      rpcRequests.push({
        body: init?.body ? JSON.parse(init.body as string) : undefined,
      });
      if (call++ === 0) return sse([requiredEvent]);
      if (ending === 'error') throw new Error('stream reset after submit');
      return sse([]);
    }) as unknown as typeof globalThis.fetch;
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
      },
    });

    let error: X402ReconciliationError | undefined;
    try {
      for await (const _event of client.sendMessageStream({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
      })) {
        // consume
      }
    } catch (reason) {
      error = reason as X402ReconciliationError;
    }
    expect(error).toBeInstanceOf(X402ReconciliationError);
    expect(error!.reason).toBe('ambiguous-response');
    expect(error!.channelId).toBe(signedChannelId(rpcRequests));
  });

  it('raises when the merchant inflates the cumulative beyond the signed ceiling', async () => {
    // Reporting 9999 after a 1000 voucher would make the payer's next call
    // sign a cumulative above what it ever authorized, plus a top-up to cover
    // the gap — letting the merchant claim far more than the calls cost.
    const { channels, storage } = channelStorage();
    let recorded: Array<{ body: unknown }> = [];
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(batchRequiredTask()),
      () => {
        const task = completedTaskWithChannelReceipt(
          signedChannelId(recorded),
        ) as {
          status: { message: { metadata: Record<string, unknown> } };
        };
        const receipts = task.status.message.metadata[
          X402_METADATA_KEYS.RECEIPTS
        ] as Array<{ extra: { channelState: { chargedCumulativeAmount: string } } }>;
        receipts[0]!.extra.channelState.chargedCumulativeAmount = '9999';
        return jsonRpcOk(task);
      },
    ]);
    recorded = rpcRequests;
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
      },
    });
    await expect(
      client.sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
      }),
    ).rejects.toBeInstanceOf(X402ReconciliationError);
    expect(channels.size).toBe(0);
  });

  it('throws X402ReconciliationError carrying the task when storage fails', async () => {
    // A lost receipt is a funds-bearing failure with no self-heal path, so it
    // must not pass silently — but the caller still keeps the result it paid
    // for, on the error.
    const { storage } = channelStorage();
    let recorded: Array<{ body: unknown }> = [];
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(batchRequiredTask()),
      () => jsonRpcOk(completedTaskWithChannelReceipt(signedChannelId(recorded))),
    ]);
    recorded = rpcRequests;
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: {
          storage: {
            ...storage,
            set: async () => {
              throw new Error('durable store unavailable');
            },
          },
        },
        allowBatchSettlement: true,
      },
    });

    const error = await client
      .sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
      })
      .then(
        () => undefined,
        (e: unknown) => e as X402ReconciliationError,
      );
    expect(error).toBeInstanceOf(X402ReconciliationError);
    expect(error!.channelId).toBe(signedChannelId(rpcRequests));
    expect((error!.task as Task).status.state).toBe('completed');
  });

  it('routes a reconciliation failure to onReconcileError instead of throwing', async () => {
    const { storage } = channelStorage();
    let recorded: Array<{ body: unknown }> = [];
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(batchRequiredTask()),
      () => jsonRpcOk(completedTaskWithChannelReceipt(signedChannelId(recorded))),
    ]);
    recorded = rpcRequests;
    const seen: X402ReconciliationError[] = [];
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: {
          storage: {
            ...storage,
            set: async () => {
              throw new Error('durable store unavailable');
            },
          },
        },
        allowBatchSettlement: true,
        onReconcileError: (error) => {
          seen.push(error);
        },
      },
    });
    const task = await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    });
    expect(task.status.state).toBe('completed');
    expect(seen).toHaveLength(1);
    expect(seen[0]!.channelId).toBe(signedChannelId(rpcRequests));
  });

  it('refuses an unfunded channel whose actual deposit exceeds maxAmount', async () => {
    // The offer costs 1000 and passes a 1000 request cap, but opening its
    // channel signs a 5x deposit authorization. The signing-time hook sees the
    // actual 5000 deposit after storage reports the channel is unfunded.
    const { storage } = channelStorage();
    const { fetch } = scriptedFetch([() => jsonRpcOk(batchRequiredTask())]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
        maxAmount: 1000n,
      },
    });
    await expect(
      client.sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
      }),
    ).rejects.toThrow(/deposit of 5000 exceeds maxAmount 1000/);
  });

  it('allows a funded channel to pay voucher-only below maxAmount', async () => {
    // A static 5x pre-filter rejected this even though the peer reads storage,
    // sees enough balance, and never invokes the deposit-sizing hook.
    const { channels, storage } = channelStorage();
    const fundedStorage = {
      ...storage,
      get: async (key: string) =>
        channels.get(key) ?? {
          balance: '5000',
          chargedCumulativeAmount: '0',
          totalClaimed: '0',
        },
    };
    let recorded: Array<{ body: unknown }> = [];
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(batchRequiredTask()),
      () => jsonRpcOk(completedTaskWithChannelReceipt(signedChannelId(recorded))),
    ]);
    recorded = rpcRequests;
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage: fundedStorage },
        allowBatchSettlement: true,
        maxAmount: 1000n,
      },
    });
    const task = await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    });
    expect(task.status.state).toBe('completed');

    const followup = (
      rpcRequests[1]!.body as {
        params: { message: { metadata: Record<string, unknown> } };
      }
    ).params.message.metadata;
    const payload = followup[X402_METADATA_KEYS.PAYLOAD] as {
      payload: { type: string };
    };
    expect(payload.payload.type).toBe('voucher');
  });

  it('fails closed on an unusable depositMultiplier instead of throwing', async () => {
    // `BigInt(5.5)` throws a RangeError. Raised inside offer filtering that
    // would surface from `sendMessage` as an opaque runtime error rather than
    // an x402 one — and a cap that cannot compute the deposit must not report
    // it affordable. `@x402/evm` rejects any multiplier below 3 anyway, so
    // excluding the offer loses nothing that could have been signed.
    // 1 and 2 are integers but below `@x402/evm`'s floor of 3 — accepting
    // them would pass the affordability filter only to fail during scheme
    // construction with a generic error.
    for (const depositMultiplier of [5.5, 0, -1, NaN, 1, 2]) {
      const { storage } = channelStorage();
      const { fetch } = scriptedFetch([() => jsonRpcOk(batchRequiredTask())]);
      const client = new A2XClient(AGENT_URL, {
        fetch,
        x402: {
          signer: TEST_ACCOUNT,
          batchSettlement: { storage, depositPolicy: { depositMultiplier } },
          allowBatchSettlement: true,
          maxAmount: 1_000_000n,
        },
      });
      await expect(
        client.sendMessage({
          message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
        }),
        `depositMultiplier: ${depositMultiplier}`,
      ).rejects.toThrow(X402NoSupportedRequirementError);
    }
  });

  it('honors a valid custom depositMultiplier when capping', async () => {
    // 1000 x 20 = 20000, over a 10000 cap.
    const { storage } = channelStorage();
    const { fetch } = scriptedFetch([() => jsonRpcOk(batchRequiredTask())]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage, depositPolicy: { depositMultiplier: 20 } },
        allowBatchSettlement: true,
        maxAmount: 10_000n,
      },
    });
    await expect(
      client.sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
      }),
    ).rejects.toThrow(/deposit of 20000 exceeds maxAmount 10000/);
  });

  it('admits a depositStrategy result that fits maxAmount', async () => {
    // The offer filter cannot predict a strategy's figure, so the cap is
    // enforced where the deposit is actually sized. 1000 fits a 1000 cap.
    const { storage } = channelStorage();
    let recorded: Array<{ body: unknown }> = [];
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(batchRequiredTask()),
      () => jsonRpcOk(completedTaskWithChannelReceipt(signedChannelId(recorded))),
    ]);
    recorded = rpcRequests;
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: {
          storage,
          depositStrategy: ({ minimumDepositAmount }) => minimumDepositAmount,
        },
        allowBatchSettlement: true,
        maxAmount: 1000n,
      },
    });
    const task = await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    });
    expect(task.status.state).toBe('completed');
  });

  it('refuses a depositStrategy result that exceeds maxAmount', async () => {
    // Without this the strategy would slip past a cap the option documents as
    // always enforced, signing an authorization larger than the wallet agreed
    // to. The offer filter cannot catch it — only the sizing site can.
    const { storage } = channelStorage();
    const { fetch } = scriptedFetch([() => jsonRpcOk(batchRequiredTask())]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: {
          storage,
          depositStrategy: () => '999999',
        },
        allowBatchSettlement: true,
        maxAmount: 1000n,
      },
    });
    await expect(
      client.sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
      }),
    ).rejects.toThrow(/exceeds maxAmount/);
  });

  it('caps the policy-computed deposit a strategy defers to with undefined', async () => {
    // `undefined` means "use the policy amount" — that is the value that
    // would be signed, so it is checked too. 5 x 1000 over a 2000 cap.
    const { storage } = channelStorage();
    const { fetch } = scriptedFetch([() => jsonRpcOk(batchRequiredTask())]);
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage, depositStrategy: () => undefined },
        allowBatchSettlement: true,
        maxAmount: 2000n,
      },
    });
    await expect(
      client.sendMessage({
        message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
      }),
    ).rejects.toThrow(/exceeds maxAmount/);
  });

  it('admits the same offer once maxAmount covers the whole deposit', async () => {
    const { storage } = channelStorage();
    let recorded: Array<{ body: unknown }> = [];
    const { fetch, rpcRequests } = scriptedFetch([
      () => jsonRpcOk(batchRequiredTask()),
      () => jsonRpcOk(completedTaskWithChannelReceipt(signedChannelId(recorded))),
    ]);
    recorded = rpcRequests;
    const client = new A2XClient(AGENT_URL, {
      fetch,
      x402: {
        signer: TEST_ACCOUNT,
        batchSettlement: { storage },
        allowBatchSettlement: true,
        maxAmount: 5000n,
      },
    });
    const task = await client.sendMessage({
      message: { messageId: 'm1', role: 'user', parts: [{ text: 'hi' }] },
    });
    expect(task.status.state).toBe('completed');
  });

  it('leaves storage untouched when no batchSettlement is configured', async () => {
    // A plain `exact` payer must never pay the cost of the batch peer, and
    // receipts without channelState must not reach it.
    const { fetch } = scriptedFetch([
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

/**
 * Storage semantics of `reconcileX402BatchSettlement` against the **real**
 * `@x402/evm`, which merges onto the stored record and assigns each field only
 * when the receipt still carries it. Asserting on the receipt handed to the
 * peer cannot observe that, which is how a guard that merely deleted a
 * distrusted `balance` looked correct while leaving storage unfunded.
 */
describe('reconcileX402BatchSettlement — storage after upstream merge', () => {
  const CHANNEL = `0x${'cd'.repeat(32)}`;
  const KEY = CHANNEL.toLowerCase();

  function store() {
    const channels = new Map<string, Record<string, unknown>>();
    return {
      channels,
      storage: {
        get: async (key: string) => channels.get(key),
        set: async (key: string, state: Record<string, unknown>) => {
          channels.set(key, state);
        },
        delete: async (key: string) => {
          channels.delete(key);
        },
      },
    };
  }

  function receipt(channelState: Record<string, unknown>) {
    return {
      success: true,
      transaction: '',
      network: 'eip155:84532',
      extra: { channelState: { channelId: CHANNEL, ...channelState } },
    };
  }

  const openingDeposit = {
    channelId: CHANNEL,
    maxClaimableAmount: '1000',
    depositAmount: '5000',
  };

  it('establishes the signed deposit when the merchant reports zero', async () => {
    const { channels, storage } = store();
    await reconcileX402BatchSettlement(
      [
        receipt({
          chargedCumulativeAmount: '1000',
          balance: '0',
          totalClaimed: '0',
        }),
      ],
      { storage, bindings: openingDeposit },
    );
    expect(channels.get(KEY)).toMatchObject({
      balance: '5000',
      chargedCumulativeAmount: '1000',
    });
  });

  it('establishes it when the merchant omits balance entirely', async () => {
    // Deleting the key would leave the peer's merge with no balance at all —
    // indistinguishable from an unfunded channel on the next call.
    const { channels, storage } = store();
    await reconcileX402BatchSettlement(
      [receipt({ chargedCumulativeAmount: '1000', totalClaimed: '0' })],
      { storage, bindings: openingDeposit },
    );
    expect(channels.get(KEY)).toMatchObject({
      balance: '5000',
      chargedCumulativeAmount: '1000',
    });
  });

  it('adds a top-up to the stored balance rather than keeping the stale figure', async () => {
    const { channels, storage } = store();
    await storage.set(KEY, { balance: '5000', chargedCumulativeAmount: '5000' });
    await reconcileX402BatchSettlement(
      [receipt({ chargedCumulativeAmount: '6000', balance: '5000' })],
      {
        storage,
        bindings: {
          channelId: CHANNEL,
          maxClaimableAmount: '6000',
          depositAmount: '5000',
        },
      },
    );
    expect(channels.get(KEY)).toMatchObject({
      balance: '10000',
      chargedCumulativeAmount: '6000',
    });
  });

  it('keeps an honest balance at or above the floor', async () => {
    const { channels, storage } = store();
    await reconcileX402BatchSettlement(
      [receipt({ chargedCumulativeAmount: '1000', balance: '5000' })],
      { storage, bindings: openingDeposit },
    );
    expect(channels.get(KEY)).toMatchObject({ balance: '5000' });
  });

  it('holds a voucher-only payment at the stored balance', async () => {
    // No deposit signed, so the floor is whatever is already stored — the
    // merchant cannot talk it down, and nothing new is established either.
    const { channels, storage } = store();
    await storage.set(KEY, { balance: '5000', chargedCumulativeAmount: '1000' });
    await reconcileX402BatchSettlement(
      [receipt({ chargedCumulativeAmount: '2000', balance: '0' })],
      { storage, bindings: { channelId: CHANNEL, maxClaimableAmount: '2000' } },
    );
    expect(channels.get(KEY)).toMatchObject({
      balance: '5000',
      chargedCumulativeAmount: '2000',
    });
  });

  it('does not reapply deposits or roll back on replayed receipts', async () => {
    const { channels, storage } = store();
    await storage.set(KEY, { balance: '5000', chargedCumulativeAmount: '2000' });
    await reconcileX402BatchSettlement(
      [receipt({ chargedCumulativeAmount: '1000', balance: '5000' })],
      {
        storage,
        bindings: {
          channelId: CHANNEL,
          maxClaimableAmount: '1000',
          depositAmount: '5000',
        },
      },
    );
    expect(channels.get(KEY)).toEqual({
      balance: '5000',
      chargedCumulativeAmount: '2000',
    });

    const opening = receipt({ chargedCumulativeAmount: '3000', balance: '5000' });
    const fresh = store();
    const binding = {
      channelId: CHANNEL,
      maxClaimableAmount: '3000',
      depositAmount: '5000',
    };
    await reconcileX402BatchSettlement([opening], {
      storage: fresh.storage,
      bindings: binding,
    });
    await reconcileX402BatchSettlement([opening], {
      storage: fresh.storage,
      bindings: binding,
    });
    expect(fresh.channels.get(KEY)).toEqual({
      balance: '5000',
      chargedCumulativeAmount: '3000',
    });
  });

  it('repairs an opening deposit when a failed write persisted only the cumulative', async () => {
    const channels = new Map<string, Record<string, unknown>>();
    let writes = 0;
    const storage = {
      get: async (key: string) => channels.get(key),
      set: async (key: string, state: Record<string, unknown>) => {
        writes += 1;
        if (writes === 1) {
          channels.set(key, {
            chargedCumulativeAmount: state.chargedCumulativeAmount,
          });
          throw new Error('partial write');
        }
        channels.set(key, state);
      },
      delete: async (key: string) => {
        channels.delete(key);
      },
    };
    const opening = receipt({
      chargedCumulativeAmount: '1000',
      balance: '0',
    });

    await expect(
      reconcileX402BatchSettlement([opening], {
        storage,
        bindings: openingDeposit,
      }),
    ).rejects.toThrow(AggregateError);
    expect(channels.get(KEY)).toEqual({ chargedCumulativeAmount: '1000' });

    await expect(
      reconcileX402BatchSettlement([opening], {
        storage,
        bindings: openingDeposit,
      }),
    ).resolves.toEqual({ applied: [CHANNEL] });
    expect(channels.get(KEY)).toMatchObject({
      balance: '5000',
      chargedCumulativeAmount: '1000',
    });
    expect(writes).toBe(2);
  });

  it('repairs a top-up when a failed write persisted only the new cumulative', async () => {
    const channels = new Map<string, Record<string, unknown>>([
      [KEY, { balance: '5000', chargedCumulativeAmount: '5000' }],
    ]);
    let writes = 0;
    const storage = {
      get: async (key: string) => channels.get(key),
      set: async (key: string, state: Record<string, unknown>) => {
        writes += 1;
        if (writes === 1) {
          channels.set(key, {
            balance: '5000',
            chargedCumulativeAmount: state.chargedCumulativeAmount,
          });
          throw new Error('partial write');
        }
        channels.set(key, state);
      },
      delete: async (key: string) => {
        channels.delete(key);
      },
    };
    const topUp = receipt({
      chargedCumulativeAmount: '6000',
      balance: '5000',
    });
    const binding = {
      channelId: CHANNEL,
      maxClaimableAmount: '6000',
      depositAmount: '5000',
    };

    await expect(
      reconcileX402BatchSettlement([topUp], { storage, bindings: binding }),
    ).rejects.toThrow(AggregateError);
    expect(channels.get(KEY)).toEqual({
      balance: '5000',
      chargedCumulativeAmount: '6000',
    });

    await expect(
      reconcileX402BatchSettlement([topUp], { storage, bindings: binding }),
    ).resolves.toEqual({ applied: [CHANNEL] });
    expect(channels.get(KEY)).toEqual({
      balance: '10000',
      chargedCumulativeAmount: '6000',
    });
    expect(writes).toBe(2);
  });

  it('serializes concurrent receipts so a delayed older write cannot roll back', async () => {
    const channels = new Map<string, Record<string, unknown>>([
      [KEY, { balance: '5000', chargedCumulativeAmount: '1000' }],
    ]);
    let newerWritten!: () => void;
    const waitForNewer = new Promise<void>((resolve) => {
      newerWritten = resolve;
    });
    const storage = {
      get: async (key: string) => channels.get(key),
      set: async (key: string, state: Record<string, unknown>) => {
        if (state.chargedCumulativeAmount === '2000') {
          // Without per-channel serialization, let the newer call finish
          // first and this delayed write deterministically rolls it back.
          await Promise.race([
            waitForNewer,
            new Promise<void>((resolve) => setTimeout(resolve, 25)),
          ]);
        }
        channels.set(key, state);
        if (state.chargedCumulativeAmount === '3000') newerWritten();
      },
      delete: async (key: string) => {
        channels.delete(key);
      },
    };

    await Promise.all([
      reconcileX402BatchSettlement(
        [receipt({ chargedCumulativeAmount: '2000', balance: '5000' })],
        { storage, bindings: { channelId: CHANNEL, maxClaimableAmount: '2000' } },
      ),
      reconcileX402BatchSettlement(
        [receipt({ chargedCumulativeAmount: '3000', balance: '5000' })],
        { storage, bindings: { channelId: CHANNEL, maxClaimableAmount: '3000' } },
      ),
    ]);

    expect(channels.get(KEY)).toMatchObject({
      balance: '5000',
      chargedCumulativeAmount: '3000',
    });
  });
});
