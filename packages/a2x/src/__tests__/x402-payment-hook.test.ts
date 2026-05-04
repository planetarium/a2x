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
import {
  x402PaymentHook,
  x402RequestPayment,
  readX402Settlement,
} from '../x402/payment.js';
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

class PaidEchoAgent extends BaseAgent {
  private readonly _accepts: X402Accept[];
  constructor(accepts: X402Accept[]) {
    super({ name: 'paid-echo-agent', description: 'Echoes paid requests.' });
    this._accepts = accepts;
  }
  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    if (!readX402Settlement(context).paid) {
      yield* x402RequestPayment({ accepts: this._accepts });
      return;
    }
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

interface HarnessOptions {
  facilitator: X402Facilitator;
  accepts?: X402Accept[];
  retryOnFailure?: boolean;
}

function makeHarness(options: HarnessOptions): {
  executor: AgentExecutor;
} {
  const accepts = options.accepts ?? [DEFAULT_ACCEPT];
  const agent = new PaidEchoAgent(accepts);
  const runner = new InMemoryRunner({ agent, appName: 'test' });
  const executor = new AgentExecutor({
    runner,
    runConfig: { streamingMode: StreamingMode.SSE },
    inputRoundTripHooks: [
      x402PaymentHook({
        facilitator: options.facilitator,
        retryOnFailure: options.retryOnFailure,
      }),
    ],
  });
  return { executor };
}

const mockFacilitator = (
  overrides: Partial<X402Facilitator> = {},
): X402Facilitator => ({
  verify: async () => ({
    isValid: true,
    invalidReason: undefined,
    payer: TEST_ACCOUNT.address,
  }),
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
): Promise<{
  payload: X402PaymentPayload;
  requirement: X402PaymentRequirements;
  metadata: Record<string, unknown>;
}> {
  return signX402Payment(task, { signer: TEST_ACCOUNT });
}

// ─── Tests ─────────────────────────────────────────────────────────────

describe('x402PaymentHook — request/submit flow', () => {
  it('emits payment-required when no x402 metadata is present', async () => {
    const { executor } = makeHarness({ facilitator: mockFacilitator() });
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
    const accept: X402Accept = {
      ...DEFAULT_ACCEPT,
      resource: 'https://api.example.com/premium-feed',
      description: 'Premium market data',
    };
    const { executor } = makeHarness({
      facilitator: mockFacilitator(),
      accepts: [accept],
    });
    const result = await executor.execute(newTask(), newMessage());
    const required = (
      result.status.message?.metadata as Record<string, unknown>
    )[X402_METADATA_KEYS.REQUIRED] as {
      accepts: { resource: string; description: string }[];
    };
    expect(required.accepts[0].resource).toBe('https://api.example.com/premium-feed');
    expect(required.accepts[0].description).toBe('Premium market data');
  });

  it('verifies, settles, and executes the inner agent on payment-submitted', async () => {
    const { executor } = makeHarness({ facilitator: mockFacilitator() });

    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signAgainst(first);

    const completed = await executor.execute(
      first,
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
    const { executor } = makeHarness({ facilitator: mockFacilitator() });

    const first = await executor.execute(newTask(), newMessage());
    const result = await executor.execute(
      first,
      newMessage({
        metadata: { [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.SUBMITTED },
      }),
    );

    expect(result.status.state).toBe(TaskState.FAILED);
    const meta = result.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.INVALID_PAYLOAD);
  });

  it('maps nonce_reused verify failure to DUPLICATE_NONCE (spec §9.1)', async () => {
    const { executor } = makeHarness({
      facilitator: mockFacilitator({
        verify: async () => ({
          isValid: false,
          invalidReason: 'nonce_reused',
          payer: TEST_ACCOUNT.address,
        }),
      }),
    });

    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signAgainst(first);

    const result = await executor.execute(
      first,
      newMessage({ messageId: 'm2', metadata }),
    );

    expect(result.status.state).toBe(TaskState.FAILED);
    const meta = result.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.DUPLICATE_NONCE);
    const receipts = meta[X402_METADATA_KEYS.RECEIPTS] as X402SettleResponse[];
    expect(receipts[0]).toMatchObject({
      success: false,
      errorReason: expect.any(String),
    });
  });

  it('maps insufficient_balance verify failure to INSUFFICIENT_FUNDS (spec §9.1)', async () => {
    const { executor } = makeHarness({
      facilitator: mockFacilitator({
        verify: async () => ({
          isValid: false,
          invalidReason: 'invalid_exact_evm_insufficient_balance',
          payer: TEST_ACCOUNT.address,
        }),
      }),
    });
    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signAgainst(first);
    const result = await executor.execute(
      first,
      newMessage({ messageId: 'm2', metadata }),
    );
    const meta = result.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.INSUFFICIENT_FUNDS);
  });

  it('falls back to VERIFY_FAILED when invalidReason does not match any spec §9.1 code', async () => {
    const { executor } = makeHarness({
      facilitator: mockFacilitator({
        verify: async () => ({
          isValid: false,
          invalidReason: 'something_the_sdk_does_not_recognize',
          payer: TEST_ACCOUNT.address,
        }),
      }),
    });
    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signAgainst(first);
    const result = await executor.execute(
      first,
      newMessage({ messageId: 'm2', metadata }),
    );
    const meta = result.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.VERIFY_FAILED);
  });

  it('emits SETTLEMENT_FAILED when facilitator.settle() fails', async () => {
    const { executor } = makeHarness({
      facilitator: mockFacilitator({
        settle: async () => ({
          success: false,
          errorReason: 'insufficient_funds',
          transaction: '',
          network: 'base-sepolia',
          payer: TEST_ACCOUNT.address,
        }),
      }),
    });

    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signAgainst(first);

    const result = await executor.execute(
      first,
      newMessage({ messageId: 'm2', metadata }),
    );

    expect(result.status.state).toBe(TaskState.FAILED);
    const meta = result.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.SETTLEMENT_FAILED);
  });

  it('emits NETWORK_MISMATCH when the submitted payload targets an unaccepted network', async () => {
    const baseAccept: X402Accept = { ...DEFAULT_ACCEPT, network: 'base' };
    const { executor } = makeHarness({
      facilitator: mockFacilitator(),
      accepts: [baseAccept],
    });

    const first = await executor.execute(newTask(), newMessage());
    const { payload } = await signAgainst(first);
    const mutated: X402PaymentPayload = { ...payload, network: 'base-sepolia' };

    const result = await executor.execute(
      first,
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
    const { executor } = makeHarness({ facilitator: mockFacilitator() });
    const first = await executor.execute(newTask(), newMessage());
    const { payload } = await signAgainst(first);

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
      first,
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
    const { executor } = makeHarness({ facilitator: mockFacilitator() });
    const first = await executor.execute(newTask(), newMessage());

    const result = await executor.execute(
      first,
      newMessage({
        metadata: { [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REJECTED },
      }),
    );

    expect(result.status.state).toBe(TaskState.FAILED);
    const meta = result.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.STATUS]).toBe(X402_PAYMENT_STATUS.REJECTED);
  });

  it('populates payer on success receipts (x402-v1 §5.3.2)', async () => {
    const FACILITATOR_PAYER = '0x9999999999999999999999999999999999999999';
    const { executor } = makeHarness({
      facilitator: mockFacilitator({
        verify: async () => ({
          isValid: true,
          invalidReason: undefined,
          payer: FACILITATOR_PAYER,
        }),
        settle: async () => ({
          success: true,
          transaction: '0xdeadbeef',
          network: 'base-sepolia',
          payer: FACILITATOR_PAYER,
        }),
      }),
    });
    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signAgainst(first);
    const completed = await executor.execute(
      first,
      newMessage({ messageId: 'm2', metadata }),
    );
    const receipts = (
      completed.status.message?.metadata as Record<string, unknown>
    )[X402_METADATA_KEYS.RECEIPTS] as X402SettleResponse[];
    expect(receipts[0]).toMatchObject({
      success: true,
      payer: FACILITATOR_PAYER,
    });
  });

  it('populates payer on failure receipts even when the facilitator omits it', async () => {
    const { executor } = makeHarness({
      facilitator: mockFacilitator({
        verify: async () => ({
          isValid: false,
          invalidReason: 'invalid_signature',
          payer: undefined as unknown as string,
        }),
      }),
    });
    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signAgainst(first);
    const result = await executor.execute(
      first,
      newMessage({ messageId: 'm2', metadata }),
    );
    const receipts = (
      result.status.message?.metadata as Record<string, unknown>
    )[X402_METADATA_KEYS.RECEIPTS] as X402SettleResponse[];
    expect(receipts[0]?.payer).toBe(TEST_ACCOUNT.address);
  });

  it('preserves prior receipts when payment completes after a previous failure (spec §7 history)', async () => {
    const { executor } = makeHarness({
      facilitator: mockFacilitator(),
      retryOnFailure: true,
    });

    // Run #1: agent emits payment-required.
    const task = await executor.execute(newTask(), newMessage());

    // Run #2: client submits a malformed payload to provoke a retry-failure
    // round-trip. The task stays in input-required and the failure receipt
    // gets recorded.
    const failed = await executor.execute(
      task,
      newMessage({
        messageId: 'm-fail',
        metadata: { [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.SUBMITTED },
      }),
    );
    expect(failed.status.state).toBe(TaskState.INPUT_REQUIRED);

    // Run #3: client signs a valid payload and the task completes. Prior
    // failure receipt is preserved alongside the success receipt.
    const { metadata } = await signAgainst(failed);
    const completed = await executor.execute(
      failed,
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
    const { executor } = makeHarness({
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
      first,
      newMessage({ messageId: 'm2', metadata }),
    );

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

describe('x402PaymentHook — streaming', () => {
  it('yields a single input-required event when payment is missing', async () => {
    const { executor } = makeHarness({ facilitator: mockFacilitator() });
    const events: unknown[] = [];

    for await (const event of executor.executeStream(newTask(), newMessage())) {
      events.push(event);
    }

    // The streaming path emits a `working` status update first, then the
    // request-input → INPUT_REQUIRED transition. Both are status updates.
    const statusEvents = events.filter(
      (e): e is { status: { state: TaskState } } =>
        typeof e === 'object' && e !== null && 'status' in e,
    );
    const states = statusEvents.map((e) => e.status.state);
    expect(states).toContain(TaskState.WORKING);
    expect(states).toContain(TaskState.INPUT_REQUIRED);
    const last = statusEvents[statusEvents.length - 1];
    expect(last.status.state).toBe(TaskState.INPUT_REQUIRED);
  });

  it('runs the inner stream after payment verifies', async () => {
    const { executor } = makeHarness({ facilitator: mockFacilitator() });
    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signAgainst(first);

    const events: unknown[] = [];
    for await (const event of executor.executeStream(
      first,
      newMessage({ messageId: 'm2', metadata }),
    )) {
      events.push(event);
    }

    const statusEvents = events.filter(
      (e): e is { status: { state: TaskState } } =>
        typeof e === 'object' && e !== null && 'status' in e,
    );
    const states = statusEvents.map((e) => e.status.state);
    expect(states).toContain(TaskState.WORKING);
    expect(states).toContain(TaskState.COMPLETED);
  });

  it('emits a payment-verified status event between submitted and completed (spec §7.1 lifecycle)', async () => {
    const { executor } = makeHarness({ facilitator: mockFacilitator() });
    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signAgainst(first);

    const events: unknown[] = [];
    for await (const event of executor.executeStream(
      first,
      newMessage({ messageId: 'm2', metadata }),
    )) {
      events.push(event);
    }

    const verifiedIdx = events.findIndex((e) => {
      if (typeof e !== 'object' || e === null || !('status' in e)) return false;
      const status = (e as {
        status: { state: TaskState; message?: { metadata?: Record<string, unknown> } };
      }).status;
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
    const { executor } = makeHarness({ facilitator: mockFacilitator() });
    const first = await executor.execute(newTask(), newMessage());

    const events: unknown[] = [];
    for await (const event of executor.executeStream(
      first,
      newMessage({
        metadata: { [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REJECTED },
      }),
    )) {
      events.push(event);
    }

    const statusEvents = events.filter(
      (e): e is {
        status: { state: TaskState; message?: { metadata?: Record<string, unknown> } };
      } => typeof e === 'object' && e !== null && 'status' in e,
    );
    const last = statusEvents[statusEvents.length - 1];
    expect(last.status.state).toBe(TaskState.FAILED);
    expect(last.status.message?.metadata?.[X402_METADATA_KEYS.STATUS]).toBe(
      X402_PAYMENT_STATUS.REJECTED,
    );
  });
});

describe('x402PaymentHook — conditional gating moves into agent.run()', () => {
  it('passes the message through to the inner agent when the agent decides not to charge', async () => {
    // Replacement for the old `requiresPayment` predicate test: the
    // decision moves into the agent. When the agent doesn't yield
    // `request-input`, the executor never invokes the hook and the
    // request flows through normally.
    class FreeEchoAgent extends BaseAgent {
      constructor() {
        super({ name: 'free-echo' });
      }
      async *run(_context: InvocationContext): AsyncGenerator<AgentEvent> {
        yield { type: 'text', text: 'pong', role: 'agent' };
        yield { type: 'done' };
      }
    }
    const agent = new FreeEchoAgent();
    const runner = new InMemoryRunner({ agent, appName: 'test-free' });
    const executor = new AgentExecutor({
      runner,
      runConfig: { streamingMode: StreamingMode.SSE },
      inputRoundTripHooks: [
        x402PaymentHook({ facilitator: mockFacilitator() }),
      ],
    });

    const result = await executor.execute(newTask(), newMessage());

    expect(result.status.state).toBe(TaskState.COMPLETED);
    expect(result.artifacts?.[0]?.parts[0]).toMatchObject({ text: 'pong' });
  });
});
