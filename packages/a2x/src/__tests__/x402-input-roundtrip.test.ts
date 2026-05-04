/**
 * New-surface tests covering the `request-input` AgentEvent + the
 * `InputRoundTripHook` plumbing.
 *
 * The class-port tests in `x402-payment-hook.test.ts` exhaustively cover
 * the prior wire behavior on the new surface; this file focuses on
 * scenarios the class-based path could not express:
 *
 *  - Agent-side observation of `readX402Settlement(context).paid` on the
 *    resume turn (FR-CORE-003).
 *  - Streaming `payment-verified` intermediate emission count (BR / Q-14).
 *  - BR-8: yields after `request-input` are silently dropped.
 *  - S4 generic input-required round-trip (custom domain, no x402 hook).
 */
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Message } from '../types/common.js';
import { TaskState, type Task } from '../types/task.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { BaseAgent, type AgentEvent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';
import {
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
} from '../x402/constants.js';
import {
  x402PaymentHook,
  x402RequestPayment,
  readX402Settlement,
  X402_DOMAIN,
} from '../x402/payment.js';
import { signX402Payment } from '../x402/client.js';
import type { X402Accept, X402Facilitator } from '../x402/types.js';
import {
  INPUT_ROUNDTRIP_METADATA_KEY,
  type InputRoundTripHook,
} from '../a2x/input-roundtrip.js';

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

function newTask(): Task {
  return {
    id: 't1',
    contextId: 'c1',
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

class PaidEchoAgent extends BaseAgent {
  observed: { paid: boolean } | undefined;
  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    const settlement = readX402Settlement(context);
    this.observed = { paid: settlement.paid };
    if (!settlement.paid) {
      yield* x402RequestPayment({ accepts: [DEFAULT_ACCEPT] });
      return;
    }
    yield { type: 'text', text: 'pong', role: 'agent' };
    yield { type: 'done' };
  }
}

function makeExecutor(facilitator: X402Facilitator): {
  agent: PaidEchoAgent;
  executor: AgentExecutor;
} {
  const agent = new PaidEchoAgent({
    name: 'paid-echo',
    description: 'echo with payment gate',
  });
  const runner = new InMemoryRunner({ agent, appName: 'roundtrip-test' });
  const executor = new AgentExecutor({
    runner,
    runConfig: { streamingMode: StreamingMode.SSE },
    inputRoundTripHooks: [x402PaymentHook({ facilitator })],
  });
  return { agent, executor };
}

describe('input-required round-trip — x402 wire shape', () => {
  it('agent.run yielding x402RequestPayment surfaces wire metadata + private record', async () => {
    const { executor } = makeExecutor(mockFacilitator());
    const task = await executor.execute(newTask(), newMessage());

    expect(task.status.state).toBe(TaskState.INPUT_REQUIRED);
    const meta = task.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.STATUS]).toBe(X402_PAYMENT_STATUS.REQUIRED);
    expect(meta[X402_METADATA_KEYS.REQUIRED]).toMatchObject({
      x402Version: 1,
      accepts: expect.any(Array),
    });

    // Private bookkeeping key.
    const record = meta[INPUT_ROUNDTRIP_METADATA_KEY] as {
      domain: string;
      payload: { accepts: X402Accept[] };
    };
    expect(record.domain).toBe(X402_DOMAIN);
    expect(record.payload.accepts).toEqual([DEFAULT_ACCEPT]);
  });

  it('readX402Settlement(context).paid is true on the resume turn after verify+settle', async () => {
    const { agent, executor } = makeExecutor(mockFacilitator());

    const first = await executor.execute(newTask(), newMessage());
    expect(agent.observed).toEqual({ paid: false });

    const { metadata } = await signX402Payment(first, { signer: TEST_ACCOUNT });

    const completed = await executor.execute(
      first,
      newMessage({ messageId: 'm2', metadata }),
    );

    expect(completed.status.state).toBe(TaskState.COMPLETED);
    expect(agent.observed).toEqual({ paid: true });
    const finalMeta = completed.status.message?.metadata as Record<
      string,
      unknown
    >;
    expect(finalMeta[X402_METADATA_KEYS.STATUS]).toBe(X402_PAYMENT_STATUS.COMPLETED);
  });

  it('verify failure with retryOnFailure=false terminates failed and appends the failure receipt', async () => {
    const facilitator = mockFacilitator({
      verify: async () => ({
        isValid: false,
        invalidReason: 'invalid_signature',
        payer: TEST_ACCOUNT.address,
      }),
    });
    const agent = new PaidEchoAgent({ name: 'a' });
    const runner = new InMemoryRunner({ agent, appName: 'test' });
    const executor = new AgentExecutor({
      runner,
      runConfig: { streamingMode: StreamingMode.SSE },
      inputRoundTripHooks: [
        x402PaymentHook({ facilitator, retryOnFailure: false }),
      ],
    });
    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signX402Payment(first, { signer: TEST_ACCOUNT });
    const result = await executor.execute(
      first,
      newMessage({ messageId: 'm2', metadata }),
    );

    expect(result.status.state).toBe(TaskState.FAILED);
    const meta = result.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.STATUS]).toBe(X402_PAYMENT_STATUS.FAILED);
    const receipts = meta[X402_METADATA_KEYS.RECEIPTS] as unknown[];
    expect(receipts).toHaveLength(1);
  });

  it('verify failure with retryOnFailure=true re-issues input-required with the prior error carried in `error`', async () => {
    const facilitator = mockFacilitator({
      verify: async () => ({
        isValid: false,
        invalidReason: 'invalid_signature',
        payer: TEST_ACCOUNT.address,
      }),
    });
    const agent = new PaidEchoAgent({ name: 'a' });
    const runner = new InMemoryRunner({ agent, appName: 'test' });
    const executor = new AgentExecutor({
      runner,
      runConfig: { streamingMode: StreamingMode.SSE },
      inputRoundTripHooks: [
        x402PaymentHook({ facilitator, retryOnFailure: true }),
      ],
    });
    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signX402Payment(first, { signer: TEST_ACCOUNT });
    const result = await executor.execute(
      first,
      newMessage({ messageId: 'm2', metadata }),
    );

    expect(result.status.state).toBe(TaskState.INPUT_REQUIRED);
    const meta = result.status.message?.metadata as Record<string, unknown>;
    const required = meta[X402_METADATA_KEYS.REQUIRED] as { error?: string };
    expect(required.error).toContain('invalid_signature');
    const receipts = meta[X402_METADATA_KEYS.RECEIPTS] as unknown[];
    expect(receipts).toHaveLength(1);

    // The reissued record must keep the original `accepts` payload so a
    // subsequent retry can still recover them.
    const record = meta[INPUT_ROUNDTRIP_METADATA_KEY] as {
      payload: { accepts: X402Accept[] };
    };
    expect(record.payload.accepts).toEqual([DEFAULT_ACCEPT]);
  });

  it('client-sent payment-rejected terminates with payment-rejected metadata', async () => {
    const { executor } = makeExecutor(mockFacilitator());
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
});

describe('input-required round-trip — streaming payment-verified intermediate', () => {
  it('emits exactly one payment-verified WORKING status update between submit and completed', async () => {
    const { executor } = makeExecutor(mockFacilitator());
    const first = await executor.execute(newTask(), newMessage());
    const { metadata } = await signX402Payment(first, { signer: TEST_ACCOUNT });

    const events: unknown[] = [];
    for await (const event of executor.executeStream(
      first,
      newMessage({ messageId: 'm2', metadata }),
    )) {
      events.push(event);
    }

    const verified = events.filter((e) => {
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
    expect(verified).toHaveLength(1);
  });
});

describe('input-required round-trip — BR-8: yields after request-input are dropped', () => {
  it('text yielded after request-input never reaches the wire', async () => {
    class LeakyAgent extends BaseAgent {
      async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
        if (!readX402Settlement(context).paid) {
          yield* x402RequestPayment({ accepts: [DEFAULT_ACCEPT] });
          // Bug pattern: continue yielding after asking for payment.
          yield { type: 'text', role: 'agent', text: 'ghost' };
          yield { type: 'done' };
          return;
        }
        yield { type: 'done' };
      }
    }
    const agent = new LeakyAgent({ name: 'leaky' });
    const runner = new InMemoryRunner({ agent, appName: 'leaky-test' });
    const executor = new AgentExecutor({
      runner,
      runConfig: { streamingMode: StreamingMode.SSE },
      inputRoundTripHooks: [
        x402PaymentHook({ facilitator: mockFacilitator() }),
      ],
    });
    const task = await executor.execute(newTask(), newMessage());

    expect(task.status.state).toBe(TaskState.INPUT_REQUIRED);
    expect(task.artifacts).toBeUndefined();
    expect(task.status.message?.parts).not.toContainEqual(
      expect.objectContaining({ text: 'ghost' }),
    );
  });
});

describe('input-required round-trip — generic domain (S4)', () => {
  it('non-x402 domain round-trips through `context.input.resumeMetadata` even without a registered hook', async () => {
    const APPROVAL_DOMAIN = 'test.approval';

    let observed: InvocationContext['input'] | undefined;
    class ApprovalAgent extends BaseAgent {
      async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
        if (!context.input) {
          yield {
            type: 'request-input',
            domain: APPROVAL_DOMAIN,
            metadata: {
              'test.approval.required': { reviewerId: 'alice', topic: 'delete' },
            },
            message: 'Awaiting approval',
            payload: { topic: 'delete' },
          };
          return;
        }
        observed = context.input;
        const granted =
          context.input.resumeMetadata['test.approval.granted'] === true;
        if (granted) {
          yield { type: 'text', role: 'agent', text: 'ok' };
          yield { type: 'done' };
        } else {
          yield { type: 'error', error: new Error('declined') };
        }
      }
    }
    const agent = new ApprovalAgent({ name: 'approver' });
    const runner = new InMemoryRunner({ agent, appName: 'approval-test' });
    const executor = new AgentExecutor({
      runner,
      runConfig: { streamingMode: StreamingMode.SSE },
      // No hook registered for `test.approval` — the executor falls
      // through, runs the agent again, and lets the agent inspect
      // `context.input.resumeMetadata` directly.
    });

    const first = await executor.execute(newTask(), newMessage());
    expect(first.status.state).toBe(TaskState.INPUT_REQUIRED);

    const second = await executor.execute(
      first,
      newMessage({
        messageId: 'm2',
        metadata: { 'test.approval.granted': true },
      }),
    );
    expect(second.status.state).toBe(TaskState.COMPLETED);
    expect(observed?.previous.domain).toBe(APPROVAL_DOMAIN);
    expect(observed?.previous.payload).toEqual({ topic: 'delete' });
    expect(observed?.resumeMetadata['test.approval.granted']).toBe(true);
  });

  it('non-x402 domain with a registered hook receives the outcome via `context.input.outcome`', async () => {
    const APPROVAL_DOMAIN = 'test.approval';

    const approvalHook: InputRoundTripHook = {
      domain: APPROVAL_DOMAIN,
      async handleResume({ message }) {
        const granted = message.metadata?.['test.approval.granted'] === true;
        return {
          resumed: granted,
          data: { granted },
          finalMetadataPatch: { 'test.approval.outcome': granted ? 'ok' : 'no' },
        };
      },
    };

    let observed: InvocationContext['input'] | undefined;
    class ApprovalAgent extends BaseAgent {
      async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
        if (!context.input) {
          yield {
            type: 'request-input',
            domain: APPROVAL_DOMAIN,
            metadata: { 'test.approval.required': { reviewerId: 'bob' } },
            payload: { topic: 'shutdown' },
          };
          return;
        }
        observed = context.input;
        yield { type: 'done' };
      }
    }
    const agent = new ApprovalAgent({ name: 'approver-with-hook' });
    const runner = new InMemoryRunner({ agent, appName: 'approval-test' });
    const executor = new AgentExecutor({
      runner,
      runConfig: { streamingMode: StreamingMode.SSE },
      inputRoundTripHooks: [approvalHook],
    });

    const first = await executor.execute(newTask(), newMessage());
    const second = await executor.execute(
      first,
      newMessage({
        messageId: 'm2',
        metadata: { 'test.approval.granted': true },
      }),
    );

    expect(second.status.state).toBe(TaskState.COMPLETED);
    expect(observed?.outcome?.data).toEqual({ granted: true });
    const finalMeta = second.status.message?.metadata as Record<string, unknown>;
    expect(finalMeta['test.approval.outcome']).toBe('ok');
  });
});
