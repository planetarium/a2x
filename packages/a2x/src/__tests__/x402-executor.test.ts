import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Message } from '../types/common.js';
import { TaskState, type Task } from '../types/task.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { BaseAgent, type AgentEvent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';
import {
  X402_ERROR_CODES,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
} from '../x402/constants.js';
import { X402PaymentExecutor } from '../x402/executor.js';
import { signX402Payment } from '../x402/client.js';
import type {
  X402Accept,
  X402Facilitator,
  X402PaymentPayload,
  X402PaymentRequirements,
  X402SettleResponse,
} from '../x402/types.js';

// ─── Fixtures ──────────────────────────────────────────────────────────

// Deterministic test key (NEVER use for anything real).
const TEST_PRIVATE_KEY =
  '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVATE_KEY);
const PAY_TO = '0x2222222222222222222222222222222222222222';
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const DEFAULT_ACCEPT: X402Accept = {
  network: 'base-sepolia',
  amount: '10000',
  asset: USDC_BASE_SEPOLIA,
  payTo: PAY_TO,
  resource: 'https://example.com/protected',
  description: 'Test access',
};

class EchoAgent extends BaseAgent {
  constructor() {
    super({ name: 'echo-agent', description: 'Echoes the request back' });
  }
  async *run(_context: InvocationContext): AsyncGenerator<AgentEvent> {
    yield { type: 'text', text: 'pong', role: 'agent' };
    yield { type: 'done' };
  }
}

function newTask(id = 't1', contextId = 'c1'): Task {
  return {
    id,
    contextId,
    status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
  };
}

function newMessage(overrides: Partial<Message> = {}): Message {
  return {
    messageId: 'm1',
    role: 'user',
    parts: [{ text: 'hi' }],
    ...overrides,
  };
}

function makeExecutor(
  facilitator: X402Facilitator,
  accepts: X402Accept[] = [DEFAULT_ACCEPT],
): X402PaymentExecutor {
  const agent = new EchoAgent();
  const runner = new InMemoryRunner({ agent, appName: 'test' });
  const inner = new AgentExecutor({
    runner,
    runConfig: { streamingMode: StreamingMode.SSE },
  });
  return new X402PaymentExecutor(inner, { accepts, facilitator });
}

const mockFacilitator = (
  overrides: Partial<X402Facilitator> = {},
): X402Facilitator => ({
  verify: async () => ({ isValid: true, invalidReason: undefined, payer: TEST_ACCOUNT.address }),
  settle: async () => ({
    success: true,
    transaction: '0xdeadbeef',
    network: 'base-sepolia',
    payer: TEST_ACCOUNT.address,
  }),
  ...overrides,
});

async function signAgainst(
  task: Task,
): Promise<{ payload: X402PaymentPayload; requirement: X402PaymentRequirements; metadata: Record<string, unknown> }> {
  const signed = await signX402Payment(task, { signer: TEST_ACCOUNT });
  return signed;
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('X402PaymentExecutor — request/submit flow', () => {
  it('emits payment-required when no x402 metadata is present', async () => {
    const executor = makeExecutor(mockFacilitator());
    const task = newTask();

    const result = await executor.execute(task, newMessage());

    expect(result.status.state).toBe(TaskState.INPUT_REQUIRED);
    const metadata = result.status.message?.metadata as Record<string, unknown>;
    expect(metadata[X402_METADATA_KEYS.STATUS]).toBe(X402_PAYMENT_STATUS.REQUIRED);
    expect(metadata[X402_METADATA_KEYS.REQUIRED]).toMatchObject({
      x402Version: 1,
      accepts: expect.any(Array),
    });
  });

  it('emits the merchant-supplied resource and description verbatim (no fabricated defaults — issue #123)', async () => {
    // x402 v1 §PaymentRequirements requires both fields; the SDK used to
    // fill them with `'a2a-x402/access'` / `''` when callers omitted
    // them. The X402Accept type now requires both, so this just verifies
    // the values flow through to the wire untouched.
    const accept: X402Accept = {
      ...DEFAULT_ACCEPT,
      resource: 'https://api.example.com/premium-feed',
      description: 'Premium market data',
    };
    const executor = makeExecutor(mockFacilitator(), [accept]);
    const result = await executor.execute(newTask(), newMessage());
    const required = (
      result.status.message?.metadata as Record<string, unknown>
    )[X402_METADATA_KEYS.REQUIRED] as { accepts: { resource: string; description: string }[] };
    expect(required.accepts[0].resource).toBe('https://api.example.com/premium-feed');
    expect(required.accepts[0].description).toBe('Premium market data');
  });

  it('verifies, settles, and executes the inner agent on payment-submitted', async () => {
    const executor = makeExecutor(mockFacilitator());

    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signAgainst(first);

    const completed = await executor.execute(
      newTask(),
      newMessage({
        messageId: 'm2',
        metadata,
      }),
    );

    expect(completed.status.state).toBe(TaskState.COMPLETED);
    const receipts = (
      completed.status.message?.metadata as Record<string, unknown> | undefined
    )?.[X402_METADATA_KEYS.RECEIPTS];
    expect(receipts).toEqual([
      expect.objectContaining({ success: true, transaction: '0xdeadbeef' }),
    ]);
    expect(completed.artifacts?.[0]?.parts[0]).toMatchObject({ text: 'pong' });
  });

  it('emits INVALID_PAYLOAD when payment-submitted has no payload', async () => {
    const executor = makeExecutor(mockFacilitator());

    const result = await executor.execute(
      newTask(),
      newMessage({
        metadata: { [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.SUBMITTED },
      }),
    );

    expect(result.status.state).toBe(TaskState.FAILED);
    const meta = result.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.INVALID_PAYLOAD);
  });

  it('maps nonce_reused verify failure to DUPLICATE_NONCE (spec §9.1)', async () => {
    const executor = makeExecutor(
      mockFacilitator({
        verify: async () => ({
          isValid: false,
          invalidReason: 'nonce_reused',
          payer: TEST_ACCOUNT.address,
        }),
      }),
    );

    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signAgainst(first);

    const result = await executor.execute(
      newTask(),
      newMessage({ messageId: 'm2', metadata }),
    );

    expect(result.status.state).toBe(TaskState.FAILED);
    const meta = result.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.DUPLICATE_NONCE);
    const receipts = meta[X402_METADATA_KEYS.RECEIPTS] as X402SettleResponse[];
    expect(receipts[0]).toMatchObject({ success: false, errorReason: expect.any(String) });
  });

  it('maps insufficient_balance verify failure to INSUFFICIENT_FUNDS (spec §9.1)', async () => {
    const executor = makeExecutor(
      mockFacilitator({
        verify: async () => ({
          isValid: false,
          invalidReason: 'invalid_exact_evm_insufficient_balance',
          payer: TEST_ACCOUNT.address,
        }),
      }),
    );
    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signAgainst(first);
    const result = await executor.execute(
      newTask(),
      newMessage({ messageId: 'm2', metadata }),
    );
    const meta = result.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.INSUFFICIENT_FUNDS);
  });

  it('falls back to VERIFY_FAILED when invalidReason does not match any spec §9.1 code', async () => {
    const executor = makeExecutor(
      mockFacilitator({
        verify: async () => ({
          isValid: false,
          invalidReason: 'something_the_sdk_does_not_recognize',
          payer: TEST_ACCOUNT.address,
        }),
      }),
    );
    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signAgainst(first);
    const result = await executor.execute(
      newTask(),
      newMessage({ messageId: 'm2', metadata }),
    );
    const meta = result.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.VERIFY_FAILED);
  });

  it('emits SETTLEMENT_FAILED when facilitator.settle() fails', async () => {
    const executor = makeExecutor(
      mockFacilitator({
        settle: async () => ({
          success: false,
          errorReason: 'insufficient_funds',
          transaction: '',
          network: 'base-sepolia',
          payer: TEST_ACCOUNT.address,
        }),
      }),
    );

    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signAgainst(first);

    const result = await executor.execute(
      newTask(),
      newMessage({ messageId: 'm2', metadata }),
    );

    expect(result.status.state).toBe(TaskState.FAILED);
    const meta = result.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.SETTLEMENT_FAILED);
  });

  it('emits NETWORK_MISMATCH when the submitted payload targets an unaccepted network', async () => {
    const executor = makeExecutor(mockFacilitator(), [
      { ...DEFAULT_ACCEPT, network: 'base' },
    ]);

    const first = await executor.execute(newTask(), newMessage());
    // Signed against the "base" requirement but we mutate the payload to
    // look like it came from base-sepolia before submitting.
    const { payload } = await signAgainst(first);
    const mutated: X402PaymentPayload = { ...payload, network: 'base-sepolia' };

    const result = await executor.execute(
      newTask(),
      newMessage({
        messageId: 'm2',
        metadata: {
          [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.SUBMITTED,
          [X402_METADATA_KEYS.PAYLOAD]: mutated,
        },
      }),
    );

    expect(result.status.state).toBe(TaskState.FAILED);
    const meta = result.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.NETWORK_MISMATCH);
  });

  it('emits INVALID_AMOUNT when authorization value is greater than maxAmountRequired (spec §9.1)', async () => {
    const executor = makeExecutor(mockFacilitator());
    const first = await executor.execute(newTask(), newMessage());
    const { payload } = await signAgainst(first);

    // Tamper with the signed payload to inflate the amount (the facilitator
    // would normally catch this; we assert the SDK catches it first).
    const tampered: X402PaymentPayload = {
      ...payload,
      payload: {
        ...payload.payload,
        authorization: {
          ...(payload.payload as { authorization: Record<string, string> }).authorization,
          value: '9999999999',
        },
      } as X402PaymentPayload['payload'],
    };

    const result = await executor.execute(
      newTask(),
      newMessage({
        messageId: 'm2',
        metadata: {
          [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.SUBMITTED,
          [X402_METADATA_KEYS.PAYLOAD]: tampered,
        },
      }),
    );

    expect(result.status.state).toBe(TaskState.FAILED);
    const meta = result.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.INVALID_AMOUNT);
  });

  it('terminates the task when client sends payment-rejected (spec §5.4.2)', async () => {
    const executor = makeExecutor(mockFacilitator());

    const result = await executor.execute(
      newTask(),
      newMessage({
        metadata: { [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REJECTED },
      }),
    );

    expect(result.status.state).toBe(TaskState.FAILED);
    const meta = result.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.STATUS]).toBe(X402_PAYMENT_STATUS.REJECTED);
  });

  it('preserves prior receipts when payment completes after a previous failure (spec §7 history)', async () => {
    const executor = makeExecutor(mockFacilitator());

    // Seed the task with a prior failure receipt that a retry would keep.
    const task = newTask();
    task.status = {
      state: TaskState.INPUT_REQUIRED,
      timestamp: new Date().toISOString(),
      message: {
        messageId: 'prior',
        role: 'agent',
        parts: [{ text: 'retry' }],
        metadata: {
          [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
          [X402_METADATA_KEYS.REQUIRED]: {
            x402Version: 1,
            accepts: [],
          },
          [X402_METADATA_KEYS.RECEIPTS]: [
            {
              success: false,
              transaction: '',
              network: 'base-sepolia',
              errorReason: 'prior attempt failed',
            },
          ],
        },
      },
    };

    const { metadata } = await signAgainst(
      await executor.execute(newTask(), newMessage()),
    );
    const completed = await executor.execute(
      task,
      newMessage({ messageId: 'm2', metadata }),
    );

    const receipts = (
      completed.status.message?.metadata as Record<string, unknown>
    )[X402_METADATA_KEYS.RECEIPTS] as X402SettleResponse[];
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({ success: false });
    expect(receipts[1]).toMatchObject({ success: true });
  });

  it('re-issues payment-required with error field when retryOnFailure=true (spec §5.1 error field)', async () => {
    const agent = new EchoAgent();
    const runner = new InMemoryRunner({ agent, appName: 'test' });
    const inner = new AgentExecutor({
      runner,
      runConfig: { streamingMode: StreamingMode.SSE },
    });
    const executor = new X402PaymentExecutor(inner, {
      accepts: [DEFAULT_ACCEPT],
      facilitator: mockFacilitator({
        verify: async () => ({
          isValid: false,
          invalidReason: 'invalid_exact_evm_insufficient_balance',
          payer: TEST_ACCOUNT.address,
        }),
      }),
      retryOnFailure: true,
    });

    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signAgainst(first);
    const result = await executor.execute(
      newTask(),
      newMessage({ messageId: 'm2', metadata }),
    );

    // retryOnFailure keeps the task alive in input-required with the
    // failure reason carried on the new payment-required response.
    expect(result.status.state).toBe(TaskState.INPUT_REQUIRED);
    const meta = result.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.STATUS]).toBe(X402_PAYMENT_STATUS.REQUIRED);
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.INSUFFICIENT_FUNDS);
    const required = meta[X402_METADATA_KEYS.REQUIRED] as {
      error?: string;
      accepts: unknown[];
    };
    expect(required.error).toContain('insufficient_balance');
    expect(required.accepts).toHaveLength(1);
  });
});

describe('X402PaymentExecutor — streaming', () => {
  it('yields a single input-required event when payment is missing', async () => {
    const executor = makeExecutor(mockFacilitator());
    const events: unknown[] = [];

    for await (const event of executor.executeStream(newTask(), newMessage())) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    const evt = events[0] as { status: { state: TaskState } };
    expect(evt.status.state).toBe(TaskState.INPUT_REQUIRED);
  });

  it('runs the inner stream after payment verifies', async () => {
    const executor = makeExecutor(mockFacilitator());
    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signAgainst(first);

    const events: unknown[] = [];
    for await (const event of executor.executeStream(
      newTask(),
      newMessage({ messageId: 'm2', metadata }),
    )) {
      events.push(event);
    }

    // Expect at least a status update for WORKING and a final COMPLETED.
    const statusEvents = events.filter(
      (e): e is { status: { state: TaskState } } =>
        typeof e === 'object' && e !== null && 'status' in e,
    );
    const states = statusEvents.map((e) => e.status.state);
    expect(states).toContain(TaskState.WORKING);
    expect(states).toContain(TaskState.COMPLETED);
  });

  it('emits a payment-verified status event between submitted and completed (spec §7.1 lifecycle)', async () => {
    const executor = makeExecutor(mockFacilitator());
    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signAgainst(first);

    const events: unknown[] = [];
    for await (const event of executor.executeStream(
      newTask(),
      newMessage({ messageId: 'm2', metadata }),
    )) {
      events.push(event);
    }

    // Find the transient `working + payment-verified` event. It must
    // occur before any COMPLETED event so streaming clients can show
    // "settling on-chain…" progress.
    const verifiedIdx = events.findIndex((e) => {
      if (typeof e !== 'object' || e === null || !('status' in e)) return false;
      const status = (e as { status: { state: TaskState; message?: { metadata?: Record<string, unknown> } } }).status;
      return (
        status.state === TaskState.WORKING &&
        status.message?.metadata?.[X402_METADATA_KEYS.STATUS] ===
          X402_PAYMENT_STATUS.VERIFIED
      );
    });
    expect(verifiedIdx).toBeGreaterThanOrEqual(0);

    const completedIdx = events.findIndex((e) => {
      if (typeof e !== 'object' || e === null || !('status' in e)) return false;
      return (e as { status: { state: TaskState } }).status.state === TaskState.COMPLETED;
    });
    expect(completedIdx).toBeGreaterThan(verifiedIdx);
  });

  it('emits a failed terminal when streaming client sends payment-rejected', async () => {
    const executor = makeExecutor(mockFacilitator());
    const events: unknown[] = [];
    for await (const event of executor.executeStream(
      newTask(),
      newMessage({
        metadata: { [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REJECTED },
      }),
    )) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    const evt = events[0] as {
      status: { state: TaskState; message?: { metadata?: Record<string, unknown> } };
    };
    expect(evt.status.state).toBe(TaskState.FAILED);
    expect(evt.status.message?.metadata?.[X402_METADATA_KEYS.STATUS]).toBe(
      X402_PAYMENT_STATUS.REJECTED,
    );
  });
});

describe('X402PaymentExecutor — requiresPayment predicate', () => {
  it('passes the message through to the inner executor when predicate returns false', async () => {
    const executor = makeExecutor(mockFacilitator());
    const passthrough = new X402PaymentExecutor(
      (executor as unknown as { _inner: AgentExecutor })._inner,
      {
        accepts: [DEFAULT_ACCEPT],
        facilitator: mockFacilitator(),
        requiresPayment: () => false,
      },
    );

    const result = await passthrough.execute(newTask(), newMessage());

    expect(result.status.state).toBe(TaskState.COMPLETED);
    expect(result.artifacts?.[0]?.parts[0]).toMatchObject({ text: 'pong' });
  });
});
