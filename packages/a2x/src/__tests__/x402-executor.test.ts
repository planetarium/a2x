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

  it('emits VERIFY_FAILED when facilitator.verify() returns isValid=false', async () => {
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
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.VERIFY_FAILED);
    const receipts = meta[X402_METADATA_KEYS.RECEIPTS] as X402SettleResponse[];
    expect(receipts[0]).toMatchObject({ success: false, errorReason: expect.any(String) });
  });

  it('emits SETTLE_FAILED when facilitator.settle() fails', async () => {
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
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.SETTLE_FAILED);
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

  it('emits AMOUNT_EXCEEDED when authorization value is greater than maxAmountRequired', async () => {
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
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.AMOUNT_EXCEEDED);
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
