import { describe, it, expect } from 'vitest';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { BaseAgent } from '../agent/base-agent.js';
import type { AgentEvent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';
import { TaskState } from '../types/task.js';
import type { Task } from '../types/task.js';
import { createSSEStream } from '../transport/sse-handler.js';

// ─── HangingAgent: emits chunks, records captured signal, hangs until aborted ───

interface HangingAgentState {
  capturedSignal: AbortSignal | undefined;
  iterationsAfterStart: number;
}

class HangingAgent extends BaseAgent {
  readonly state: HangingAgentState = {
    capturedSignal: undefined,
    iterationsAfterStart: 0,
  };

  constructor() {
    super({ name: 'hanging-agent', description: 'Hangs until signal aborts' });
  }

  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    this.state.capturedSignal = context.signal;

    // Emit a first chunk so the stream consumer sees activity.
    yield { type: 'text', text: 'chunk-0', role: 'agent' };

    while (!context.signal?.aborted) {
      this.state.iterationsAfterStart += 1;
      yield { type: 'text', text: `chunk-${this.state.iterationsAfterStart}`, role: 'agent' };
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    yield { type: 'done' };
  }
}

function createTask(): Task {
  return {
    id: 'test-task-sse-disconnect',
    contextId: 'ctx-sse',
    status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
  };
}

function createExecutor(agent: BaseAgent): AgentExecutor {
  const runner = new InMemoryRunner({ agent, appName: 'test' });
  return new AgentExecutor({
    runner,
    runConfig: { streamingMode: StreamingMode.SSE },
  });
}

const testMessage = {
  messageId: 'msg-sse-1',
  role: 'user' as const,
  parts: [{ text: 'hello' }],
};

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  pollMs = 5,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  return predicate();
}

describe('SSE client disconnect lifecycle (Issue #255)', () => {
  it('createSSEStream.cancel() detaches its source generator', async () => {
    const agent = new HangingAgent();
    const executor = createExecutor(agent);
    const task = createTask();

    const events = executor.executeStream(task, testMessage);
    const stream = createSSEStream(events);
    const reader = stream.getReader();

    // Read first event to confirm the stream has started producing output.
    const first = await reader.read();
    expect(first.done).toBe(false);
    expect(first.value).toBeDefined();

    // The transport source is a subscription in production. Returning a
    // direct executor here proves that createSSEStream still detaches its
    // own source instead of retaining passive subscribers.
    await reader.cancel();
    const aborted = await waitUntil(
      () => agent.state.capturedSignal?.aborted === true,
      200,
    );
    expect(aborted).toBe(true);

    // Natural completion still cleans up the executor controller.
    const controllers = (executor as unknown as {
      _abortControllers: Map<string, AbortController>;
    })._abortControllers;
    const cleaned = await waitUntil(() => !controllers.has(task.id), 200);
    expect(cleaned).toBe(true);
  });

  it('suppresses a pending source failure after the reader disconnects', async () => {
    const release = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
    async function* events(): AsyncGenerator<unknown> {
      try {
        yield { status: 'working' };
        await release.promise;
        throw new Error('failed after disconnect');
      } finally {
        finished.resolve();
      }
    }

    const reader = createSSEStream(events()).getReader();
    expect((await reader.read()).done).toBe(false);
    await reader.cancel();
    release.resolve();

    await finished.promise;
  });

  it('AgentExecutor cleanup aborts controller when the outer generator is .return()ed mid-stream', async () => {
    const agent = new HangingAgent();
    const executor = createExecutor(agent);
    const task = createTask();

    const stream = executor.executeStream(task, testMessage);

    // Consume two events (typically: working-status + first text artifact).
    const first = await stream.next();
    expect(first.done).toBe(false);
    const second = await stream.next();
    expect(second.done).toBe(false);

    // Terminate the generator directly — mimics the SSE handler's cancel path.
    await stream.return(undefined);

    const aborted = await waitUntil(
      () => agent.state.capturedSignal?.aborted === true,
      200,
    );
    expect(aborted).toBe(true);

    const controllers = (executor as unknown as {
      _abortControllers: Map<string, AbortController>;
    })._abortControllers;
    expect(controllers.has(task.id)).toBe(false);
  });
});
