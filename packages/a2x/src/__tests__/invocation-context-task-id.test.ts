/**
 * Regression tests for issue #158: `InvocationContext` must expose the
 * A2A wire identifiers (`taskId` / `contextId`) and they must be stable
 * across the `request-input` → resume cycle. The per-invocation
 * `session.id` is not safe to bind durable per-task state to.
 */
import { describe, expect, it } from 'vitest';
import type { Message } from '../types/common.js';
import { TaskState, type Task } from '../types/task.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { BaseAgent, type AgentEvent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';

function newTask(overrides: Partial<Task> = {}): Task {
  return {
    id: 't1',
    contextId: 'c1',
    status: { state: TaskState.SUBMITTED, timestamp: new Date().toISOString() },
    ...overrides,
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

/**
 * Records every InvocationContext observed across runs so the test can
 * assert taskId/contextId stability across the request-input → resume
 * boundary.
 */
class IdentityRecordingAgent extends BaseAgent {
  observations: Array<{
    taskId: string | undefined;
    contextId: string | undefined;
    sessionId: string;
  }> = [];

  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    this.observations.push({
      taskId: context.taskId,
      contextId: context.contextId,
      sessionId: context.session.id,
    });

    if (!context.input) {
      yield {
        type: 'request-input',
        domain: 'test.identity',
        metadata: { 'test.identity.required': true },
        payload: { foo: 'bar' },
      };
      return;
    }

    yield { type: 'text', role: 'agent', text: 'ok' };
    yield { type: 'done' };
  }
}

function makeExecutor(): {
  agent: IdentityRecordingAgent;
  executor: AgentExecutor;
} {
  const agent = new IdentityRecordingAgent({ name: 'identity-recorder' });
  const runner = new InMemoryRunner({ agent, appName: 'identity-test' });
  const executor = new AgentExecutor({
    runner,
    runConfig: { streamingMode: StreamingMode.SSE },
  });
  return { agent, executor };
}

describe('InvocationContext task/context identity (issue #158)', () => {
  it('exposes task.id and task.contextId on the first turn (execute)', async () => {
    const { agent, executor } = makeExecutor();
    await executor.execute(newTask(), newMessage());

    expect(agent.observations).toHaveLength(1);
    expect(agent.observations[0]!.taskId).toBe('t1');
    expect(agent.observations[0]!.contextId).toBe('c1');
  });

  it('exposes task.id and task.contextId on the first turn (executeStream)', async () => {
    const { agent, executor } = makeExecutor();
    for await (const _ of executor.executeStream(newTask(), newMessage())) {
      // drain
    }

    expect(agent.observations).toHaveLength(1);
    expect(agent.observations[0]!.taskId).toBe('t1');
    expect(agent.observations[0]!.contextId).toBe('c1');
  });

  it('keeps taskId and contextId stable across request-input → resume (execute)', async () => {
    const { agent, executor } = makeExecutor();

    const first = await executor.execute(newTask(), newMessage());
    expect(first.status.state).toBe(TaskState.INPUT_REQUIRED);

    const completed = await executor.execute(
      first,
      newMessage({
        messageId: 'm2',
        metadata: { 'test.identity.granted': true },
      }),
    );
    expect(completed.status.state).toBe(TaskState.COMPLETED);

    expect(agent.observations).toHaveLength(2);
    const [firstObs, resumeObs] = agent.observations;

    // The wire identifiers must be stable: same A2A task, same contextId.
    expect(resumeObs!.taskId).toBe(firstObs!.taskId);
    expect(resumeObs!.contextId).toBe(firstObs!.contextId);
    expect(resumeObs!.taskId).toBe('t1');
    expect(resumeObs!.contextId).toBe('c1');

    // Session id is per-invocation (intentionally), so agents must not
    // bind durable per-task state to it.
    expect(resumeObs!.sessionId).not.toBe(firstObs!.sessionId);
  });

  it('keeps taskId and contextId stable across request-input → resume (executeStream)', async () => {
    const { agent, executor } = makeExecutor();

    const first = newTask();
    for await (const _ of executor.executeStream(first, newMessage())) {
      // drain
    }
    expect(first.status.state).toBe(TaskState.INPUT_REQUIRED);

    for await (const _ of executor.executeStream(
      first,
      newMessage({
        messageId: 'm2',
        metadata: { 'test.identity.granted': true },
      }),
    )) {
      // drain
    }
    expect(first.status.state).toBe(TaskState.COMPLETED);

    expect(agent.observations).toHaveLength(2);
    const [firstObs, resumeObs] = agent.observations;

    expect(resumeObs!.taskId).toBe(firstObs!.taskId);
    expect(resumeObs!.contextId).toBe(firstObs!.contextId);
    expect(resumeObs!.taskId).toBe('t1');
    expect(resumeObs!.contextId).toBe('c1');
    expect(resumeObs!.sessionId).not.toBe(firstObs!.sessionId);
  });

  it('falls back to task.id for contextId when task.contextId is unset', async () => {
    const { agent, executor } = makeExecutor();
    const task: Task = {
      id: 'only-task-id',
      status: {
        state: TaskState.SUBMITTED,
        timestamp: new Date().toISOString(),
      },
    };
    await executor.execute(task, newMessage());

    expect(agent.observations[0]!.taskId).toBe('only-task-id');
    expect(agent.observations[0]!.contextId).toBe('only-task-id');
  });

  it('leaves taskId/contextId undefined when the Runner is used standalone (no enclosing A2A task)', async () => {
    const agent = new IdentityRecordingAgent({ name: 'standalone' });
    const runner = new InMemoryRunner({ agent, appName: 'standalone-test' });
    const session = await runner.createSession();

    for await (const _ of runner.runAsync(session, newMessage())) {
      // drain
    }

    expect(agent.observations).toHaveLength(1);
    expect(agent.observations[0]!.taskId).toBeUndefined();
    expect(agent.observations[0]!.contextId).toBeUndefined();
  });
});
