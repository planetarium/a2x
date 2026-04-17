import { describe, it, expect } from 'vitest';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { BaseAgent } from '../agent/base-agent.js';
import type { AgentEvent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';
import { TaskState } from '../types/task.js';
import type { Task } from '../types/task.js';

// ─── Slow agent that yields multiple events with delays ───

class SlowAgent extends BaseAgent {
  constructor() {
    super({ name: 'slow-agent', description: 'Agent that checks abort signal' });
  }

  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    for (let i = 0; i < 10; i++) {
      // Check abort signal before each iteration (same pattern as LlmAgent)
      if (context.signal?.aborted) return;

      yield { type: 'text', text: `chunk-${i}`, role: 'agent' };

      // Small delay to simulate work
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    yield { type: 'done' };
  }
}

function createTask(): Task {
  return {
    id: 'test-task-1',
    contextId: 'ctx-1',
    status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
  };
}

function createExecutor(): AgentExecutor {
  const agent = new SlowAgent();
  const runner = new InMemoryRunner({ agent, appName: 'test' });
  return new AgentExecutor({
    runner,
    runConfig: { streamingMode: StreamingMode.SSE },
  });
}

const testMessage = {
  messageId: 'msg-1',
  role: 'user' as const,
  parts: [{ text: 'hello' }],
};

describe('AgentExecutor cancel / abort', () => {
  it('cancel() should abort a running execute() and stop yielding events', async () => {
    const executor = createExecutor();
    const task = createTask();

    // Start execution in background
    const executePromise = executor.execute(task, testMessage);

    // Give the agent a moment to start producing events
    await new Promise((resolve) => setTimeout(resolve, 30));

    // Cancel mid-flight
    await executor.cancel(task);

    const result = await executePromise;

    // Task should be in canceled state (set by cancel())
    expect(result.status.state).toBe(TaskState.CANCELED);
  });

  it('cancel() should abort a running executeStream() and stop yielding events', async () => {
    const executor = createExecutor();
    const task = createTask();

    const events: unknown[] = [];
    const stream = executor.executeStream(task, testMessage);

    // Collect events with a race: cancel after a short delay
    const cancelAfterDelay = new Promise<void>((resolve) => {
      setTimeout(async () => {
        await executor.cancel(task);
        resolve();
      }, 30);
    });

    // Consume events until generator ends or cancel takes effect
    const consume = (async () => {
      for await (const event of stream) {
        events.push(event);
      }
    })();

    await Promise.all([cancelAfterDelay, consume]);

    // Should have received SOME events but NOT all 10 text chunks + done
    // (SlowAgent yields 10 chunks with 10ms delay each = 100ms total,
    //  we cancel at 30ms so we should get only a few)
    expect(events.length).toBeGreaterThan(0);
    expect(events.length).toBeLessThan(12); // 10 texts + done + working = 12 max
  });

  it('cancel() on non-running task should just set status', async () => {
    const executor = createExecutor();
    const task = createTask();

    // Cancel without ever executing
    const result = await executor.cancel(task);
    expect(result.status.state).toBe(TaskState.CANCELED);
  });

  it('abort signal should be passed through to InvocationContext', async () => {
    let receivedSignal: AbortSignal | undefined;

    class SignalCapturingAgent extends BaseAgent {
      constructor() {
        super({ name: 'signal-capture', description: 'Captures signal' });
      }
      async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
        receivedSignal = context.signal;
        yield { type: 'done' };
      }
    }

    const agent = new SignalCapturingAgent();
    const runner = new InMemoryRunner({ agent, appName: 'test' });
    const executor = new AgentExecutor({
      runner,
      runConfig: { streamingMode: StreamingMode.NONE },
    });

    const task = createTask();
    await executor.execute(task, testMessage);

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal).toBeInstanceOf(AbortSignal);
    expect(receivedSignal!.aborted).toBe(false);
  });

  it('abort signal should be aborted after cancel()', async () => {
    let receivedSignal: AbortSignal | undefined;

    class HangingAgent extends BaseAgent {
      constructor() {
        super({ name: 'hanging', description: 'Hangs until aborted' });
      }
      async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
        receivedSignal = context.signal;
        // Wait until aborted
        while (!context.signal?.aborted) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        yield { type: 'done' };
      }
    }

    const agent = new HangingAgent();
    const runner = new InMemoryRunner({ agent, appName: 'test' });
    const executor = new AgentExecutor({
      runner,
      runConfig: { streamingMode: StreamingMode.NONE },
    });

    const task = createTask();

    // Start in background
    const executePromise = executor.execute(task, testMessage);

    // Wait for agent to start
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Cancel
    await executor.cancel(task);

    await executePromise;

    expect(receivedSignal).toBeDefined();
    expect(receivedSignal!.aborted).toBe(true);
  });
});
