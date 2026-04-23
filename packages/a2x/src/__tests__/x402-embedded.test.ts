/**
 * Tests for a2a-x402 v0.2 Embedded Flow support.
 *
 * Embedded Flow = the inner agent yields `paymentRequired` mid-execution,
 * the executor transitions the task into `input-required` with the
 * challenge on an artifact, and on resumption the same generator
 * continues from where it paused.
 */

import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import type { Message, Part } from '../types/common.js';
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
  X402PaymentExecutor,
  X402_EMBEDDED_ARTIFACT_NAME,
  X402_EMBEDDED_DATA_KEY,
} from '../x402/executor.js';
import {
  X402Client,
  getEmbeddedX402Challenges,
  getX402Receipts,
  signX402Payment,
} from '../x402/client.js';
import { paymentRequiredEvent } from '../x402/events.js';
import type {
  X402Accept,
  X402Facilitator,
  X402PaymentPayload,
  X402PaymentRequirements,
  X402SettleResponse,
} from '../x402/types.js';
import type { SendMessageParams } from '../types/jsonrpc.js';
import { A2XClient } from '../client/a2x-client.js';

// ─── Fixtures ──────────────────────────────────────────────────────────

const TEST_PRIVATE_KEY =
  '0x1111111111111111111111111111111111111111111111111111111111111111' as const;
const TEST_ACCOUNT = privateKeyToAccount(TEST_PRIVATE_KEY);
const PAY_TO = '0x2222222222222222222222222222222222222222';
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const GATE_ACCEPT: X402Accept = {
  network: 'base-sepolia',
  amount: '1000',
  asset: USDC_BASE_SEPOLIA,
  payTo: PAY_TO,
  description: 'Gate',
};

const EMBEDDED_ACCEPT: X402Accept = {
  network: 'base-sepolia',
  amount: '120000000', // 120 USDC
  asset: USDC_BASE_SEPOLIA,
  payTo: PAY_TO,
  description: 'Cart checkout',
};

class PreEmbedAgent extends BaseAgent {
  constructor(private readonly _accepts: X402Accept[]) {
    super({ name: 'pre-embed-agent' });
  }
  async *run(_context: InvocationContext): AsyncGenerator<AgentEvent> {
    yield { type: 'text', text: 'Preparing cart… ', role: 'agent' };
    yield paymentRequiredEvent({
      accepts: this._accepts,
      embeddedObject: {
        cartId: 'cart-abc',
        total: { currency: 'USD', value: 120 },
      },
      artifactName: 'demo-cart',
    });
    yield { type: 'text', text: 'Shipping shoes…', role: 'agent' };
    yield { type: 'done' };
  }
}

class DynamicEmbedAgent extends BaseAgent {
  constructor() {
    super({ name: 'dyn-embed-agent' });
  }
  async *run(_context: InvocationContext): AsyncGenerator<AgentEvent> {
    // No inline accepts — relies on executor's resolveAccepts hook.
    yield paymentRequiredEvent({
      embeddedObject: { productId: 'sku-42' },
    });
    yield { type: 'text', text: 'Delivered.', role: 'agent' };
    yield { type: 'done' };
  }
}

class NoAcceptsEmbedAgent extends BaseAgent {
  constructor() {
    super({ name: 'no-accepts-agent' });
  }
  async *run(_context: InvocationContext): AsyncGenerator<AgentEvent> {
    yield paymentRequiredEvent({});
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
    parts: [{ text: 'buy shoes' }],
    ...overrides,
  };
}

const mockFacilitator = (
  overrides: Partial<X402Facilitator> = {},
): X402Facilitator => ({
  verify: async () => ({
    isValid: true,
    invalidReason: undefined,
    payer: TEST_ACCOUNT.address,
  }),
  settle: async (payload) => ({
    success: true,
    transaction: `0xtx-${payload.network}-${Date.now()}`,
    network: payload.network,
    payer: TEST_ACCOUNT.address,
  }),
  ...overrides,
});

function makeExecutor(
  agent: BaseAgent,
  options: Partial<
    Parameters<typeof buildOptions>[0]
  > = {},
): X402PaymentExecutor {
  const runner = new InMemoryRunner({ agent, appName: 'test' });
  const inner = new AgentExecutor({
    runner,
    runConfig: { streamingMode: StreamingMode.SSE },
  });
  return new X402PaymentExecutor(inner, buildOptions(options));
}

function buildOptions(
  overrides: {
    accepts?: X402Accept[];
    facilitator?: X402Facilitator;
    resolveAccepts?: Parameters<
      typeof import('../x402/executor.js').X402PaymentExecutor
    >[1]['resolveAccepts'];
    requiresPayment?: (message: Message) => boolean;
  } = {},
) {
  return {
    accepts: overrides.accepts ?? [],
    facilitator: overrides.facilitator ?? mockFacilitator(),
    ...(overrides.resolveAccepts
      ? { resolveAccepts: overrides.resolveAccepts }
      : {}),
    ...(overrides.requiresPayment
      ? { requiresPayment: overrides.requiresPayment }
      : {}),
  };
}

async function signTask(
  task: Task,
): Promise<Record<string, unknown>> {
  const signed = await signX402Payment(task, { signer: TEST_ACCOUNT });
  return signed.metadata;
}

// ─── Server-side Embedded Flow ─────────────────────────────────────────

describe('X402PaymentExecutor — Embedded Flow emission', () => {
  it('emits an artifact-shaped challenge when the agent yields paymentRequired', async () => {
    const executor = makeExecutor(new PreEmbedAgent([EMBEDDED_ACCEPT]));
    const task = newTask();

    const result = await executor.execute(task, newMessage());

    expect(result.status.state).toBe(TaskState.INPUT_REQUIRED);
    // Per spec §5.3 Embedded: status.metadata has `payment-required` but
    // NOT `x402.payment.required` (that sits on the artifact instead).
    const meta = result.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.STATUS]).toBe(X402_PAYMENT_STATUS.REQUIRED);
    expect(meta[X402_METADATA_KEYS.REQUIRED]).toBeUndefined();

    expect(result.artifacts).toHaveLength(1);
    const [artifact] = result.artifacts!;
    expect(artifact!.name).toBe('demo-cart');
    const dataPart = artifact!.parts[0] as { data: Record<string, unknown> };
    expect(dataPart.data.cartId).toBe('cart-abc');
    const challenge = dataPart.data[X402_EMBEDDED_DATA_KEY] as {
      x402Version: number;
      accepts: X402PaymentRequirements[];
    };
    expect(challenge.x402Version).toBe(1);
    expect(challenge.accepts[0]!.maxAmountRequired).toBe('120000000');
  });

  it('uses resolveAccepts when the event omits inline accepts', async () => {
    const executor = makeExecutor(new DynamicEmbedAgent(), {
      resolveAccepts: (ctx) => {
        const embed = ctx.embeddedObject as { productId: string };
        expect(embed.productId).toBe('sku-42');
        return [{ ...EMBEDDED_ACCEPT, amount: '75000000' }];
      },
    });

    const result = await executor.execute(newTask(), newMessage());

    expect(result.status.state).toBe(TaskState.INPUT_REQUIRED);
    const artifact = result.artifacts![0]!;
    const dataPart = artifact.parts[0] as { data: Record<string, unknown> };
    const challenge = dataPart.data[X402_EMBEDDED_DATA_KEY] as {
      accepts: X402PaymentRequirements[];
    };
    expect(challenge.accepts[0]!.maxAmountRequired).toBe('75000000');
  });

  it('fails the task with NO_REQUIREMENTS when neither inline accepts nor resolver supply any', async () => {
    const executor = makeExecutor(new NoAcceptsEmbedAgent());

    const result = await executor.execute(newTask(), newMessage());

    expect(result.status.state).toBe(TaskState.FAILED);
    const meta = result.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.NO_REQUIREMENTS);
  });

  it('defaults the artifact name when the event does not set one', async () => {
    class NoNameAgent extends BaseAgent {
      constructor() {
        super({ name: 'no-name' });
      }
      async *run(): AsyncGenerator<AgentEvent> {
        yield paymentRequiredEvent({ accepts: [EMBEDDED_ACCEPT] });
        yield { type: 'done' };
      }
    }
    const executor = makeExecutor(new NoNameAgent());
    const result = await executor.execute(newTask(), newMessage());
    expect(result.artifacts![0]!.name).toBe(X402_EMBEDDED_ARTIFACT_NAME);
  });
});

describe('X402PaymentExecutor — Embedded Flow resume', () => {
  it('verifies the embedded payment and resumes the inner generator', async () => {
    const executor = makeExecutor(new PreEmbedAgent([EMBEDDED_ACCEPT]));

    const first = await executor.execute(newTask(), newMessage());
    expect(first.status.state).toBe(TaskState.INPUT_REQUIRED);

    const metadata = await signTask(first);
    const resumed = await executor.execute(
      first,
      newMessage({ messageId: 'm2', metadata, taskId: first.id }),
    );

    expect(resumed.status.state).toBe(TaskState.COMPLETED);

    // Final artifact combines pre- and post-payment text.
    const textArtifact = resumed.artifacts!.find((a) =>
      a.parts.some((p) => 'text' in p),
    )!;
    const textPart = textArtifact.parts.find((p) => 'text' in p) as { text: string };
    expect(textPart.text).toBe('Preparing cart… Shipping shoes…');

    // Receipts attached to the final status message.
    const receipts = getX402Receipts(resumed);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.success).toBe(true);
  });

  it('fails the task and discards the generator on verify failure', async () => {
    const executor = makeExecutor(new PreEmbedAgent([EMBEDDED_ACCEPT]), {
      facilitator: mockFacilitator({
        verify: async () => ({
          isValid: false,
          invalidReason: 'nonce_reused',
          payer: TEST_ACCOUNT.address,
        }),
      }),
    });

    const first = await executor.execute(newTask(), newMessage());
    const metadata = await signTask(first);
    const resumed = await executor.execute(
      first,
      newMessage({ messageId: 'm2', metadata, taskId: first.id }),
    );

    expect(resumed.status.state).toBe(TaskState.FAILED);
    const meta = resumed.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.VERIFY_FAILED);
  });

  it('re-emits payment-required when resume is called without payment-submitted', async () => {
    const executor = makeExecutor(new PreEmbedAgent([EMBEDDED_ACCEPT]));
    const first = await executor.execute(newTask(), newMessage());
    const retried = await executor.execute(
      first,
      newMessage({ messageId: 'm2', taskId: first.id }),
    );
    expect(retried.status.state).toBe(TaskState.INPUT_REQUIRED);
  });
});

describe('X402PaymentExecutor — gate + embedded stacking', () => {
  it('runs the gate first, then the embedded charge in sequence', async () => {
    const executor = makeExecutor(new PreEmbedAgent([EMBEDDED_ACCEPT]), {
      accepts: [GATE_ACCEPT],
    });

    // 1. Initial call → gate challenge.
    const gateChallenge = await executor.execute(newTask(), newMessage());
    expect(gateChallenge.status.state).toBe(TaskState.INPUT_REQUIRED);
    const gateMeta = gateChallenge.status.message?.metadata as Record<string, unknown>;
    expect(gateMeta[X402_METADATA_KEYS.REQUIRED]).toBeDefined();

    // 2. Client signs the gate requirement and resubmits.
    const gateSigned = await signTask(gateChallenge);
    const afterGate = await executor.execute(
      newTask(),
      newMessage({ messageId: 'm2', metadata: gateSigned }),
    );

    // 3. After the gate, agent yields paymentRequired → embedded challenge.
    expect(afterGate.status.state).toBe(TaskState.INPUT_REQUIRED);
    expect(
      (afterGate.status.message?.metadata as Record<string, unknown>)[
        X402_METADATA_KEYS.REQUIRED
      ],
    ).toBeUndefined();
    expect(afterGate.artifacts?.some((a) => a.name === 'demo-cart')).toBe(true);

    // 4. Client signs the embedded challenge and resubmits.
    const embedSigned = await signTask(afterGate);
    const completed = await executor.execute(
      afterGate,
      newMessage({ messageId: 'm3', metadata: embedSigned, taskId: afterGate.id }),
    );

    expect(completed.status.state).toBe(TaskState.COMPLETED);
    const receipts = getX402Receipts(completed);
    expect(receipts).toHaveLength(2); // gate + embedded
    expect(receipts.every((r) => r.success)).toBe(true);
  });

  it('supports gate-zero / purchase-only setups (requiresPayment returns false)', async () => {
    const executor = makeExecutor(new PreEmbedAgent([EMBEDDED_ACCEPT]), {
      accepts: [GATE_ACCEPT],
      requiresPayment: () => false, // skip gate entirely
    });

    const first = await executor.execute(newTask(), newMessage());
    expect(first.status.state).toBe(TaskState.INPUT_REQUIRED);
    // No gate was charged → only embedded challenge should be present.
    const meta = first.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.REQUIRED]).toBeUndefined();

    const signed = await signTask(first);
    const completed = await executor.execute(
      first,
      newMessage({ messageId: 'm2', metadata: signed, taskId: first.id }),
    );

    expect(completed.status.state).toBe(TaskState.COMPLETED);
    const receipts = getX402Receipts(completed);
    expect(receipts).toHaveLength(1); // embedded only
  });
});

// ─── Streaming ─────────────────────────────────────────────────────────

describe('X402PaymentExecutor — Embedded Flow streaming', () => {
  it('yields the challenge artifact and an input-required status, then resumes to completed', async () => {
    const executor = makeExecutor(new PreEmbedAgent([EMBEDDED_ACCEPT]));

    const firstEvents: unknown[] = [];
    for await (const event of executor.executeStream(newTask(), newMessage())) {
      firstEvents.push(event);
    }

    // WORKING → artifact-update(text) → artifact-update(challenge) → INPUT_REQUIRED.
    const statuses = firstEvents.filter(
      (e): e is { status: { state: TaskState } } =>
        typeof e === 'object' && e !== null && 'status' in e,
    );
    expect(statuses[0]!.status.state).toBe(TaskState.WORKING);
    expect(statuses.at(-1)!.status.state).toBe(TaskState.INPUT_REQUIRED);

    const artifacts = firstEvents.filter(
      (e): e is { artifact: { artifactId: string; name?: string } } =>
        typeof e === 'object' && e !== null && 'artifact' in e,
    );
    expect(artifacts.some((e) => e.artifact.name === 'demo-cart')).toBe(true);

    // Resume.
    const firstTask = await executor.execute(newTask('t2'), newMessage());
    const metadata = await signTask(firstTask);
    const secondEvents: unknown[] = [];
    for await (const event of executor.executeStream(
      firstTask,
      newMessage({ messageId: 'm2', metadata, taskId: firstTask.id }),
    )) {
      secondEvents.push(event);
    }
    const secondStatuses = secondEvents.filter(
      (e): e is { status: { state: TaskState } } =>
        typeof e === 'object' && e !== null && 'status' in e,
    );
    expect(secondStatuses.at(-1)!.status.state).toBe(TaskState.COMPLETED);
  });
});

// ─── Client-side helpers ───────────────────────────────────────────────

describe('getEmbeddedX402Challenges', () => {
  function taskWithEmbeddedArtifact(
    data: Record<string, unknown>,
    artifactName = 'demo-cart',
  ): Task {
    return {
      id: 't1',
      contextId: 'c1',
      status: {
        state: TaskState.INPUT_REQUIRED,
        timestamp: new Date().toISOString(),
        message: {
          messageId: 'msg',
          role: 'agent',
          parts: [{ text: 'Payment is required to continue.' }],
          metadata: {
            [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
          },
        },
      },
      artifacts: [
        {
          artifactId: 'challenge-1',
          name: artifactName,
          parts: [{ data } as Part],
        },
      ],
    };
  }

  it('parses the bare embedded shape the SDK emits', () => {
    const task = taskWithEmbeddedArtifact({
      [X402_EMBEDDED_DATA_KEY]: {
        x402Version: 1,
        accepts: [{ maxAmountRequired: '120000000', network: 'base-sepolia' }],
      },
    });
    const challenges = getEmbeddedX402Challenges(task);
    expect(challenges).toHaveLength(1);
    expect(challenges[0]!.artifactId).toBe('challenge-1');
    expect(challenges[0]!.required.accepts[0]!.maxAmountRequired).toBe('120000000');
  });

  it('finds an x402PaymentRequiredResponse nested inside a higher-level wrapper (AP2-style)', () => {
    const task = taskWithEmbeddedArtifact({
      'ap2.mandates.CartMandate': {
        id: 'cart-shoes-123',
        payment_request: {
          method_data: [
            {
              supported_methods: 'https://www.x402.org/',
              data: {
                x402Version: 1,
                accepts: [{ maxAmountRequired: '120000000', network: 'base' }],
              },
            },
          ],
        },
      },
    });
    const challenges = getEmbeddedX402Challenges(task);
    expect(challenges).toHaveLength(1);
    expect(challenges[0]!.required.accepts[0]!.network).toBe('base');
  });

  it('returns an empty array when no artifact carries a challenge', () => {
    const task: Task = {
      id: 't1',
      status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
    };
    expect(getEmbeddedX402Challenges(task)).toEqual([]);
  });
});

describe('X402Client — gate + embedded integration', () => {
  /**
   * Build a fake A2XClient that dispatches into a given executor so we
   * can exercise the client loop end-to-end without HTTP.
   */
  function makeClient(executor: X402PaymentExecutor): A2XClient {
    // A2XClient expects an HTTP URL; we stub sendMessage directly.
    const client = new A2XClient('http://stub');
    const tasks = new Map<string, Task>();
    (client as unknown as { sendMessage: typeof client.sendMessage }).sendMessage =
      async (params: SendMessageParams): Promise<Task> => {
        const existingId = (params.message as { taskId?: string }).taskId;
        let task: Task;
        if (existingId && tasks.has(existingId)) {
          task = tasks.get(existingId)!;
        } else {
          task = {
            id: `task-${tasks.size + 1}`,
            contextId: 'ctx',
            status: {
              state: TaskState.SUBMITTED,
              timestamp: new Date().toISOString(),
            },
          };
          tasks.set(task.id, task);
        }
        const result = await executor.execute(task, params.message);
        tasks.set(result.id, result);
        return result;
      };
    return client;
  }

  it('resolves both a gate challenge and an embedded challenge in one sendMessage call', async () => {
    const executor = makeExecutor(new PreEmbedAgent([EMBEDDED_ACCEPT]), {
      accepts: [GATE_ACCEPT],
    });
    const client = makeClient(executor);

    let gateCallbacks = 0;
    let embeddedCallbacks = 0;
    const x402 = new X402Client(client, {
      signer: TEST_ACCOUNT,
      onPaymentRequired: () => {
        gateCallbacks += 1;
      },
      onEmbeddedPaymentRequired: () => {
        embeddedCallbacks += 1;
      },
    });

    const task = await x402.sendMessage({
      message: {
        messageId: 'm1',
        role: 'user',
        parts: [{ text: 'buy shoes' }],
      },
    });

    expect(task.status.state).toBe(TaskState.COMPLETED);
    expect(gateCallbacks).toBe(1);
    expect(embeddedCallbacks).toBe(1);
    const receipts = getX402Receipts(task);
    expect(receipts).toHaveLength(2);
  });

  it('handles a purchase-only (no-gate) setup', async () => {
    const executor = makeExecutor(new PreEmbedAgent([EMBEDDED_ACCEPT]));
    const client = makeClient(executor);
    const x402 = new X402Client(client, { signer: TEST_ACCOUNT });

    const task = await x402.sendMessage({
      message: {
        messageId: 'm1',
        role: 'user',
        parts: [{ text: 'buy shoes' }],
      },
    });

    expect(task.status.state).toBe(TaskState.COMPLETED);
    const receipts = getX402Receipts(task);
    expect(receipts).toHaveLength(1);
  });

  it('gives up after `maxPaymentHops` hops to avoid infinite loops', async () => {
    // Build an agent that always yields paymentRequired, never completes.
    class LoopAgent extends BaseAgent {
      constructor() {
        super({ name: 'loop-agent' });
      }
      async *run(): AsyncGenerator<AgentEvent> {
        while (true) {
          yield paymentRequiredEvent({ accepts: [EMBEDDED_ACCEPT] });
        }
      }
    }
    const executor = makeExecutor(new LoopAgent());
    const client = makeClient(executor);
    const x402 = new X402Client(client, { signer: TEST_ACCOUNT, maxPaymentHops: 3 });

    const task = await x402.sendMessage({
      message: {
        messageId: 'm1',
        role: 'user',
        parts: [{ text: 'pay forever' }],
      },
    });
    // Final task is still in input-required because we bailed early.
    expect(task.status.state).toBe(TaskState.INPUT_REQUIRED);
  });
});

// ─── Marker: ensure the non-x402 executor still ignores paymentRequired ──

describe('Base AgentExecutor', () => {
  it('does not crash when the agent yields paymentRequired (ignored)', async () => {
    // Use base AgentExecutor (NOT X402PaymentExecutor) with an agent that
    // yields paymentRequired. The base switch has no case for it and
    // should fall through without throwing.
    const runner = new InMemoryRunner({
      agent: new PreEmbedAgent([EMBEDDED_ACCEPT]),
      appName: 'base-test',
    });
    const inner = new AgentExecutor({
      runner,
      runConfig: { streamingMode: StreamingMode.SSE },
    });
    const task = newTask('t-base');
    const result = await inner.execute(task, newMessage());
    // Base executor should complete normally (paymentRequired ignored).
    expect(result.status.state).toBe(TaskState.COMPLETED);
  });
});

// Suppress unused-import warnings for types used only in annotations.
void ({} as { X402PaymentPayload: X402PaymentPayload; X402SettleResponse: X402SettleResponse });
