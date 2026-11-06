import { describe, expect, it, vi } from 'vitest';
import { BaseAgent, type AgentEvent } from '../agent/base-agent.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { A2XServer } from '../a2x/a2x-agent.js';
import { InMemoryTaskStore } from '../a2x/task-store.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { DefaultRequestHandler } from '../transport/request-handler.js';
import type { Message } from '../types/common.js';
import type { JSONRPCSuccessResponse, SendMessageParams } from '../types/jsonrpc.js';
import { TaskState, type Task } from '../types/task.js';
import '../a2x/index.js';

class UnusedAgent extends BaseAgent {
  constructor() { super({ name: 'snapshot-test' }); }
  async *run(): AsyncGenerator<AgentEvent> { throw new Error('Use the unary override'); }
}

function fixture() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const store = new InMemoryTaskStore();
  const executor = new AgentExecutor({
    runner: new InMemoryRunner({ agent: new UnusedAgent(), appName: 'snapshot-test' }),
    runConfig: { streamingMode: StreamingMode.NONE },
  });
  const execute = vi.spyOn(executor, 'execute').mockImplementation(async (task) => {
    await gate;
    return { ...task, status: { state: TaskState.COMPLETED } };
  });
  const server = new A2XServer({ taskStore: store, executor, protocolVersion: '0.3' })
    .setName('snapshot-test')
    .setDescription('Detached unary snapshot regression tests')
    .setVersion('1')
    .setDefaultUrl('http://localhost/a2a');
  const handler = new DefaultRequestHandler(server);
  const send = async (params: SendMessageParams) => {
    const response = await handler.handle({
      jsonrpc: '2.0', id: 1, method: 'message/send', params,
    });
    expect(response).not.toHaveProperty('error');
    return (response as JSONRPCSuccessResponse).result as Task;
  };
  const cleanup = async () => {
    release();
    await Promise.allSettled(execute.mock.results.map((result) => result.value));
    // The in-memory persistence and event-publication continuations must finish
    // before the test releases its spies or starts another execution.
    await new Promise<void>((resolve) => setImmediate(resolve));
  };
  return { store, gate, release, execute, send, cleanup };
}

function message(): Message {
  return { messageId: 'message-1', role: 'user', parts: [{ text: 'accepted input' }] };
}

async function waitForState(store: InMemoryTaskStore, id: string, state: TaskState) {
  await vi.waitFor(async () => expect((await store.getTask(id))?.status.state).toBe(state));
  return (await store.getTask(id))!;
}

describe('detached unary request snapshots', () => {
  it('accepts task metadata containing callback leaves supported by the task store', async () => {
    const f = fixture();
    const callback = () => {};
    try {
      const accepted = await f.send({
        message: message(), configuration: { blocking: false },
        metadata: { callback, nested: { value: 'accepted' } },
      });
      expect(accepted.status.state).toBe(TaskState.WORKING);
      expect(accepted.metadata?.callback).toBe(callback);
      f.release();
      const completed = await waitForState(f.store, accepted.id, TaskState.COMPLETED);
      expect(completed.metadata?.callback).toBe(callback);
      expect(f.execute).toHaveBeenCalledTimes(1);
    } finally { await f.cleanup(); }
  });

  it('keeps accepted message data when the caller reuses its request after acknowledgement', async () => {
    const f = fixture();
    let observed: unknown;
    f.execute.mockImplementation(async (task, input) => {
      await f.gate;
      observed = {
        parts: input.parts,
        metadata: input.metadata,
        extensions: input.extensions,
      };
      return { ...task, status: { state: TaskState.COMPLETED } };
    });
    const input: Message = {
      ...message(),
      parts: [{ data: { nested: { value: 'accepted' } } }],
      metadata: { nested: { value: 'accepted' } },
      extensions: ['urn:accepted'],
    };
    try {
      const accepted = await f.send({ message: input, configuration: { blocking: false } });
      (input.parts[0] as { data: { nested: { value: string } } }).data.nested.value = 'reused';
      (input.metadata!.nested as { value: string }).value = 'reused';
      input.extensions!.push('urn:reused');
      f.release();
      await waitForState(f.store, accepted.id, TaskState.COMPLETED);
      expect(observed).toEqual({
        parts: [{ data: { nested: { value: 'accepted' } } }],
        metadata: { nested: { value: 'accepted' } },
        extensions: ['urn:accepted'],
      });
    } finally { await f.cleanup(); }
  });

  it('keeps detached final-write recovery when the caller changes configuration after acknowledgement', async () => {
    const f = fixture();
    const update = f.store.updateTask.bind(f.store);
    let completionAttempts = 0;
    vi.spyOn(f.store, 'updateTask').mockImplementation(async (id, value) => {
      if (value.status?.state === TaskState.COMPLETED && ++completionAttempts === 1) {
        throw new Error('transient completion write');
      }
      return update(id, value);
    });
    const configuration = { blocking: false };
    try {
      const accepted = await f.send({ message: message(), configuration });
      configuration.blocking = true;
      f.release();
      await waitForState(f.store, accepted.id, TaskState.COMPLETED);
      expect(completionAttempts).toBe(2);
      expect(f.execute).toHaveBeenCalledTimes(1);
    } finally { await f.cleanup(); }
  });

  it('keeps acknowledgement history and metadata unchanged when the executor mutates its input', async () => {
    const f = fixture();
    const callback = () => {};
    f.execute.mockImplementation(async (task, input) => {
      await f.gate;
      task.status.state = TaskState.COMPLETED;
      (task.metadata!.nested as { value: string }).value = 'executed';
      (input.parts[0] as { data: { nested: { value: string } } }).data.nested.value = 'executed';
      (input.metadata!.nested as { value: string }).value = 'executed';
      input.extensions!.push('urn:executed');
      return task;
    });
    try {
      const accepted = await f.send({
        message: {
          ...message(), parts: [{ data: { nested: { value: 'accepted' } } }],
          metadata: { callback, nested: { value: 'accepted' } }, extensions: ['urn:accepted'],
        },
        metadata: { callback, nested: { value: 'accepted' } },
        configuration: { blocking: false },
      });
      f.release();
      const completed = await waitForState(f.store, accepted.id, TaskState.COMPLETED);
      expect(completed.metadata?.nested).toEqual({ value: 'executed' });
      expect(accepted.status.state).toBe(TaskState.WORKING);
      expect(accepted.metadata?.nested).toEqual({ value: 'accepted' });
      expect(accepted.history?.[0]).toMatchObject({
        parts: [{ data: { nested: { value: 'accepted' } } }],
        metadata: { nested: { value: 'accepted' } },
        extensions: ['urn:accepted'],
      });
    } finally { await f.cleanup(); }
  });

  it('retries a transient failure-status write without redispatching the failed executor', async () => {
    const f = fixture();
    f.execute.mockImplementation(async () => {
      await f.gate;
      throw new Error('backend rejected the operation');
    });
    const update = f.store.updateTask.bind(f.store);
    let failureAttempts = 0;
    vi.spyOn(f.store, 'updateTask').mockImplementation(async (id, value) => {
      if (value.status?.state === TaskState.FAILED && ++failureAttempts === 1) {
        throw new Error('transient failure write');
      }
      return update(id, value);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const accepted = await f.send({ message: message(), configuration: { blocking: false } });
      f.release();
      const failed = await waitForState(f.store, accepted.id, TaskState.FAILED);
      expect(failed.status.message?.parts).toEqual([{ text: 'backend rejected the operation' }]);
      expect(failureAttempts).toBe(2);
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(log).not.toHaveBeenCalled();
    } finally {
      await f.cleanup();
      log.mockRestore();
    }
  });
});
