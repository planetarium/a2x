import { describe, it, expect } from 'vitest';
import { DefaultRequestHandler } from '../transport/request-handler.js';
import { A2XAgent } from '../a2x/a2x-agent.js';
import type { ProtocolVersion } from '../a2x/a2x-agent.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryTaskStore } from '../a2x/task-store.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { BaseAgent } from '../agent/base-agent.js';
import type { AgentEvent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';
import { TaskState } from '../types/task.js';

// Ensure mappers are registered
import '../a2x/index.js';

// Slow agent that yields N text chunks with configurable spacing so tests
// can attach a resubscriber mid-stream.
class SlowTextAgent extends BaseAgent {
  constructor(
    private readonly chunks: string[],
    private readonly delayMs: number,
  ) {
    super({ name: 'slow-text-agent', description: 'Emits text chunks with delay' });
  }

  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    for (const chunk of this.chunks) {
      if (context.signal?.aborted) return;
      yield { type: 'text', text: chunk, role: 'agent' };
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    yield { type: 'done' };
  }
}

function createSlowHandler(
  chunks: string[],
  delayMs: number,
  protocolVersion?: ProtocolVersion,
): { handler: DefaultRequestHandler; taskStore: InMemoryTaskStore } {
  const agent = new SlowTextAgent(chunks, delayMs);
  const runner = new InMemoryRunner({ agent, appName: 'test' });
  const executor = new AgentExecutor({
    runner,
    runConfig: { streamingMode: StreamingMode.SSE },
  });
  const taskStore = new InMemoryTaskStore();
  const a2xAgent = new A2XAgent({ taskStore, executor, protocolVersion });
  a2xAgent.setDefaultUrl('https://example.com/a2a');
  return { handler: new DefaultRequestHandler(a2xAgent), taskStore };
}

// Each chunk in a streaming response is a JSON-RPC success envelope per
// spec a2a-v0.3 §SendStreamingMessageSuccessResponse. Tests pull events
// out of `result` (or surface the error envelope as a fail).
type StreamEnvelope = {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
};

function unwrapResult(envelope: StreamEnvelope): Record<string, unknown> {
  if (envelope.error) {
    throw new Error(
      `Stream yielded JSON-RPC error: ${envelope.error.code} ${envelope.error.message}`,
    );
  }
  if (!envelope.result) {
    throw new Error(`Stream envelope has neither result nor error: ${JSON.stringify(envelope)}`);
  }
  return envelope.result;
}

describe('tasks/resubscribe', () => {
  it('emits a JSON-RPC error envelope when the task does not exist', async () => {
    const { handler } = createSlowHandler(['hi'], 5);

    const result = await handler.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/resubscribe',
      params: { id: 'nonexistent' },
    });

    expect(result).toBeDefined();
    expect(
      result !== null &&
        typeof result === 'object' &&
        Symbol.asyncIterator in (result as object),
    ).toBe(true);

    const generator = result as AsyncGenerator<StreamEnvelope>;
    const envelopes: StreamEnvelope[] = [];
    for await (const envelope of generator) {
      envelopes.push(envelope);
    }

    expect(envelopes).toHaveLength(1);
    expect(envelopes[0].id).toBe(1);
    // TaskNotFoundError → JSON-RPC -32001 per A2A error code table.
    expect(envelopes[0].error?.code).toBe(-32001);
  });

  it('replays terminal status event when task is already completed', async () => {
    const { handler, taskStore } = createSlowHandler(['hi'], 5, '1.0');

    // Seed a task directly in the COMPLETED state.
    const task = await taskStore.createTask({});
    await taskStore.updateTask(task.id, {
      status: {
        state: TaskState.COMPLETED,
        timestamp: new Date().toISOString(),
      },
    });

    const result = await handler.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/resubscribe',
      params: { id: task.id },
    });

    const generator = result as AsyncGenerator<StreamEnvelope>;
    const events: Record<string, unknown>[] = [];
    for await (const envelope of generator) {
      expect(envelope.id).toBe(1);
      events.push(unwrapResult(envelope));
    }

    expect(events).toHaveLength(1);
    const first = events[0];
    const status = first.status as Record<string, unknown>;
    // v1.0 uses UPPER_SNAKE_CASE state.
    expect(status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('joins a live stream and receives subsequent events', async () => {
    // 5 chunks with 10ms spacing so the resubscriber has room to attach.
    const { handler } = createSlowHandler(
      ['a', 'b', 'c', 'd', 'e'],
      10,
      '1.0',
    );

    const streamResult = await handler.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/stream',
      params: {
        message: {
          messageId: 'msg-1',
          role: 'user',
          parts: [{ text: 'Hello' }],
        },
      },
    });

    const originalEvents: Record<string, unknown>[] = [];
    const resubEvents: Record<string, unknown>[] = [];
    let taskId: string | undefined;

    const originalIter = streamResult as AsyncGenerator<StreamEnvelope>;

    const originalConsumer = (async () => {
      for await (const envelope of originalIter) {
        const event = unwrapResult(envelope);
        originalEvents.push(event);
        if (!taskId && typeof event.taskId === 'string') {
          taskId = event.taskId;
        }
      }
    })();

    // Wait for the first couple of events so the primary stream has started
    // and we can pull the taskId.
    while (originalEvents.length < 2) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    expect(taskId).toBeDefined();

    const resubResult = await handler.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tasks/resubscribe',
      params: { id: taskId! },
    });
    const resubIter = resubResult as AsyncGenerator<StreamEnvelope>;

    const resubConsumer = (async () => {
      for await (const envelope of resubIter) {
        // Resub stream's envelopes are correlated by the resub request id.
        expect(envelope.id).toBe(2);
        resubEvents.push(unwrapResult(envelope));
      }
    })();

    await Promise.all([originalConsumer, resubConsumer]);

    // The resubscriber must have received at least one artifact update and
    // the final completed status.
    const resubArtifacts = resubEvents.filter((e) => e.artifact !== undefined);
    const resubStatus = resubEvents.filter((e) => e.status !== undefined);

    expect(resubArtifacts.length).toBeGreaterThanOrEqual(1);
    expect(resubStatus.length).toBeGreaterThanOrEqual(1);

    const lastStatus = resubStatus[resubStatus.length - 1];
    const status = lastStatus.status as Record<string, unknown>;
    expect(status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('ends when the publishing stream ends', async () => {
    const { handler } = createSlowHandler(['x'], 5, '1.0');

    const streamResult = await handler.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/stream',
      params: {
        message: {
          messageId: 'msg-1',
          role: 'user',
          parts: [{ text: 'Hello' }],
        },
      },
    });

    const originalIter = streamResult as AsyncGenerator<StreamEnvelope>;
    const originalEvents: Record<string, unknown>[] = [];
    let taskId: string | undefined;

    // Read the first event from the primary stream so we have the taskId
    // while the stream is still live.
    const first = await originalIter.next();
    if (!first.done) {
      const event = unwrapResult(first.value);
      originalEvents.push(event);
      if (typeof event.taskId === 'string') {
        taskId = event.taskId;
      }
    }

    expect(taskId).toBeDefined();

    const resubResult = await handler.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tasks/resubscribe',
      params: { id: taskId! },
    });
    const resubIter = resubResult as AsyncGenerator<StreamEnvelope>;

    // Consume both streams; after the primary stream ends, the resubscriber
    // must also end (done: true).
    const originalConsumer = (async () => {
      for await (const envelope of originalIter) {
        originalEvents.push(unwrapResult(envelope));
      }
    })();

    const resubEvents: Record<string, unknown>[] = [];
    const resubConsumer = (async () => {
      for await (const envelope of resubIter) {
        resubEvents.push(unwrapResult(envelope));
      }
    })();

    await Promise.all([originalConsumer, resubConsumer]);

    const done = await resubIter.next();
    expect(done.done).toBe(true);
  });
});
