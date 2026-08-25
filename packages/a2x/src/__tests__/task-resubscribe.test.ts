import { describe, it, expect } from 'vitest';
import { DefaultRequestHandler } from '../transport/request-handler.js';
import { A2XServer } from '../a2x/a2x-agent.js';
import type { ProtocolVersion } from '../a2x/a2x-agent.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryTaskStore } from '../a2x/task-store.js';
import { InMemoryTaskEventBus } from '../a2x/task-event-bus.js';
import type { TaskEvent, TaskEventBus } from '../a2x/task-event-bus.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { BaseAgent } from '../agent/base-agent.js';
import type { AgentEvent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';
import { TaskState } from '../types/task.js';
import type { Task } from '../types/task.js';
import { createSSEStream } from '../transport/sse-handler.js';

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

class MutatingMetadataAgent extends BaseAgent {
  readonly emitFirst = Promise.withResolvers<void>();
  readonly mutate = Promise.withResolvers<void>();
  readonly mutated = Promise.withResolvers<void>();

  constructor() {
    super({ name: 'mutating-metadata-agent' });
  }

  async *run(): AsyncGenerator<AgentEvent> {
    const artifactDetails = { version: 1 };
    const updateDetails = { sequence: 1 };
    await this.emitFirst.promise;
    yield {
      type: 'text',
      text: 'first',
      artifact: { metadata: { details: artifactDetails } },
      deliveryMetadata: { details: updateDetails },
    };
    await this.mutate.promise;
    artifactDetails.version = 2;
    updateDetails.sequence = 2;
    this.mutated.resolve();
    yield { type: 'text', text: 'second' };
    yield { type: 'done' };
  }
}

class GatedTextAgent extends BaseAgent {
  readonly release = Promise.withResolvers<void>();
  readonly finish = Promise.withResolvers<void>();
  readonly finished = Promise.withResolvers<void>();
  capturedSignal: AbortSignal | undefined;

  constructor() {
    super({ name: 'gated-text-agent', description: 'Waits between chunks' });
  }

  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    try {
      this.capturedSignal = context.signal;
      yield { type: 'text', text: 'before-disconnect', role: 'agent' };
      await this.release.promise;
      if (context.signal?.aborted) return;
      yield { type: 'text', text: 'after-disconnect', role: 'agent' };
      await this.finish.promise;
      if (context.signal?.aborted) return;
      yield { type: 'done' };
    } finally {
      this.finished.resolve();
    }
  }
}

class TwoTurnAgent extends BaseAgent {
  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    const resumed =
      (context.message?.metadata as { resumed?: boolean } | undefined)
        ?.resumed === true;
    if (!resumed) {
      yield { type: 'request-input', message: 'More input required.' };
      return;
    }
    yield { type: 'text', text: 'continued', role: 'agent' };
    yield { type: 'done' };
  }
}

/** Models a distributed bus whose close operation permanently tombstones a task channel. */
class PermanentCloseTaskEventBus implements TaskEventBus {
  readonly closedTaskIds = new Set<string>();
  private readonly delegate = new InMemoryTaskEventBus();

  publish(taskId: string, event: TaskEvent): void {
    if (!this.closedTaskIds.has(taskId)) {
      this.delegate.publish(taskId, event);
    }
  }

  close(taskId: string): void {
    this.closedTaskIds.add(taskId);
    this.delegate.close(taskId);
  }

  async *subscribe(
    taskId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<TaskEvent> {
    if (this.closedTaskIds.has(taskId)) return;
    yield* this.delegate.subscribe(taskId, signal);
  }

  hasSubscribers(taskId: string): boolean {
    return this.delegate.hasSubscribers(taskId);
  }
}

class DelayedSecondSubscribeTaskEventBus extends PermanentCloseTaskEventBus {
  private subscribeCalls = 0;

  override async *subscribe(
    taskId: string,
    signal?: AbortSignal,
  ): AsyncGenerator<TaskEvent> {
    this.subscribeCalls += 1;
    if (this.subscribeCalls === 2) {
      if (!signal?.aborted) {
        await new Promise<void>((resolve) => {
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      return;
    }
    yield* super.subscribe(taskId, signal);
  }
}

class CompleteAfterStaleReadTaskStore extends InMemoryTaskStore {
  private armedTaskId: string | undefined;

  arm(taskId: string): void {
    this.armedTaskId = taskId;
  }

  override async getTask(taskId: string): Promise<Task | null> {
    const snapshot = await super.getTask(taskId);
    if (snapshot && this.armedTaskId === taskId) {
      this.armedTaskId = undefined;
      await super.updateTask(taskId, {
        status: {
          state: TaskState.COMPLETED,
          timestamp: new Date().toISOString(),
        },
      });
    }
    return snapshot;
  }
}

function createHandler(
  agent: BaseAgent,
  protocolVersion?: ProtocolVersion,
  options?: {
    taskStore?: InMemoryTaskStore;
    taskEventBus?: TaskEventBus;
  },
): {
  handler: DefaultRequestHandler;
  taskStore: InMemoryTaskStore;
  a2xServer: A2XServer;
} {
  const runner = new InMemoryRunner({ agent, appName: 'test' });
  const executor = new AgentExecutor({
    runner,
    runConfig: { streamingMode: StreamingMode.SSE },
  });
  const taskStore = options?.taskStore ?? new InMemoryTaskStore();
  const a2xServer = new A2XServer({
    taskStore,
    executor,
    protocolVersion,
    ...(options?.taskEventBus
      ? { taskEventBus: options.taskEventBus }
      : {}),
  });
  a2xServer.setDefaultUrl('https://example.com/a2a');
  return {
    handler: new DefaultRequestHandler(a2xServer),
    taskStore,
    a2xServer,
  };
}

function createSlowHandler(
  chunks: string[],
  delayMs: number,
  protocolVersion?: ProtocolVersion,
): {
  handler: DefaultRequestHandler;
  taskStore: InMemoryTaskStore;
  a2xServer: A2XServer;
} {
  return createHandler(new SlowTextAgent(chunks, delayMs), protocolVersion);
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

async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  timeoutMs = 500,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

function subscriberCount(server: A2XServer, taskId: string): number {
  const bus = server.taskEventBus as unknown as {
    subscribers: Map<string, Set<unknown>>;
  };
  return bus.subscribers.get(taskId)?.size ?? 0;
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

  it('rejects a non-terminal task that has no active execution', async () => {
    const { handler, taskStore } = createSlowHandler(['hi'], 5);
    const task = await taskStore.createTask({});
    const result = await handler.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/resubscribe',
      params: { id: task.id },
    });
    const first = await (result as AsyncGenerator<StreamEnvelope>).next();

    expect(first.done).toBe(false);
    expect(first.value.error?.code).toBe(-32603);
  });

  it('rechecks the store when execution finishes during resubscribe', async () => {
    const taskStore = new CompleteAfterStaleReadTaskStore();
    const { handler } = createHandler(
      new SlowTextAgent(['unused'], 0),
      '1.0',
      { taskStore },
    );
    const task = await taskStore.createTask({});
    await taskStore.updateTask(task.id, {
      status: {
        state: TaskState.WORKING,
        timestamp: new Date().toISOString(),
      },
    });
    taskStore.arm(task.id);

    const result = await handler.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/resubscribe',
      params: { id: task.id },
    });
    const events: Record<string, unknown>[] = [];
    for await (const envelope of result as AsyncGenerator<StreamEnvelope>) {
      events.push(unwrapResult(envelope));
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.status).toMatchObject({
      state: 'TASK_STATE_COMPLETED',
    });
  });

  it('replays terminal state when a custom bus closes before subscribe attaches', async () => {
    const taskStore = new CompleteAfterStaleReadTaskStore();
    const taskEventBus = new PermanentCloseTaskEventBus();
    const { handler } = createHandler(
      new SlowTextAgent(['unused'], 0),
      '1.0',
      { taskStore, taskEventBus },
    );
    const task = await taskStore.createTask({});
    await taskStore.updateTask(task.id, {
      status: {
        state: TaskState.WORKING,
        timestamp: new Date().toISOString(),
      },
    });
    taskStore.arm(task.id);
    taskEventBus.close(task.id);

    const result = await handler.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/resubscribe',
      params: { id: task.id },
    });
    const events: Record<string, unknown>[] = [];
    for await (const envelope of result as AsyncGenerator<StreamEnvelope>) {
      events.push(unwrapResult(envelope));
    }

    expect(events).toHaveLength(1);
    expect(events[0]?.status).toMatchObject({
      state: 'TASK_STATE_COMPLETED',
    });
  });

  it('keeps a permanently closable event bus open across continuation turns', async () => {
    const taskEventBus = new PermanentCloseTaskEventBus();
    const { handler, taskStore } = createHandler(
      new TwoTurnAgent({ name: 'two-turn' }),
      '1.0',
      { taskEventBus },
    );

    const first = await handler.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/stream',
      params: {
        message: {
          messageId: 'msg-first-turn',
          role: 'user',
          parts: [{ text: 'start' }],
        },
      },
    });
    const firstEvents: Record<string, unknown>[] = [];
    for await (const envelope of first as AsyncGenerator<StreamEnvelope>) {
      firstEvents.push(unwrapResult(envelope));
    }
    const taskId = firstEvents[0]?.taskId as string;

    expect(firstEvents.at(-1)?.status).toMatchObject({
      state: 'TASK_STATE_INPUT_REQUIRED',
    });
    expect(taskEventBus.closedTaskIds.has(taskId)).toBe(false);

    const second = await handler.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'message/stream',
      params: {
        message: {
          taskId,
          messageId: 'msg-second-turn',
          role: 'user',
          parts: [{ text: 'continue' }],
          metadata: { resumed: true },
        },
      },
    });
    const secondEvents: Record<string, unknown>[] = [];
    for await (const envelope of second as AsyncGenerator<StreamEnvelope>) {
      secondEvents.push(unwrapResult(envelope));
    }

    expect(secondEvents[0]?.taskId).toBe(taskId);
    expect(secondEvents.at(-1)?.status).toMatchObject({
      state: 'TASK_STATE_COMPLETED',
    });
    expect(taskEventBus.closedTaskIds.has(taskId)).toBe(true);
    await expect(taskStore.getTask(taskId)).resolves.toMatchObject({
      status: { state: TaskState.COMPLETED },
    });
  });

  it('replays completion when a custom bus attaches a resubscriber too late', async () => {
    const agent = new GatedTextAgent();
    const taskEventBus = new DelayedSecondSubscribeTaskEventBus();
    const { handler } = createHandler(agent, '1.0', { taskEventBus });
    const primary = (await handler.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/stream',
      params: {
        message: {
          messageId: 'msg-custom-bus-race',
          role: 'user',
          parts: [{ text: 'start' }],
        },
      },
    })) as AsyncGenerator<StreamEnvelope>;
    const first = await primary.next();
    const taskId = unwrapResult(first.value).taskId as string;
    await primary.next();

    const resub = (await handler.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tasks/resubscribe',
      params: { id: taskId },
    })) as AsyncGenerator<StreamEnvelope>;
    const delayedResult = resub.next();

    agent.release.resolve();
    agent.finish.resolve();
    for await (const _event of primary) {
      // Drain the primary through completion.
    }

    const replay = await delayedResult;
    expect(replay.done).toBe(false);
    expect(unwrapResult(replay.value).status).toMatchObject({
      state: 'TASK_STATE_COMPLETED',
    });
    await expect(resub.next()).resolves.toMatchObject({ done: true });
  });

  it('joins a live stream and receives subsequent events', async () => {
    // 5 chunks with 10ms spacing so the resubscriber has room to attach.
    const { handler, a2xServer } = createSlowHandler(
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

    // A separate binding adapter can construct its own handler over the same
    // server; execution ownership must remain shared across those handlers.
    const resubHandler = new DefaultRequestHandler(a2xServer);
    const resubResult = await resubHandler.handle({
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

  it('isolates queued live events from later agent metadata mutation', async () => {
    const agent = new MutatingMetadataAgent();
    const runner = new InMemoryRunner({ agent, appName: 'test' });
    const executor = new AgentExecutor({
      runner,
      runConfig: { streamingMode: StreamingMode.SSE },
    });
    const a2xServer = new A2XServer({
      taskStore: new InMemoryTaskStore(),
      executor,
      protocolVersion: '0.3',
    });
    a2xServer.setDefaultUrl('https://example.com/a2a');
    const handler = new DefaultRequestHandler(a2xServer);

    const originalIter = (await handler.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/stream',
      params: {
        message: {
          messageId: 'msg-metadata',
          role: 'user',
          parts: [{ text: 'Hello' }],
        },
      },
    })) as AsyncGenerator<StreamEnvelope>;

    const working = await originalIter.next();
    const taskId = unwrapResult(working.value).taskId as string;
    const resubIter = (await handler.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tasks/resubscribe',
      params: { id: taskId },
    })) as AsyncGenerator<StreamEnvelope>;
    const resubFirstPromise = resubIter.next();
    while (!a2xServer.taskEventBus.hasSubscribers(taskId)) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const originalFirstPromise = originalIter.next();
    agent.emitFirst.resolve();
    const [originalFirst, resubFirst] = await Promise.all([
      originalFirstPromise,
      resubFirstPromise,
    ]);
    const originalFirstEvent = unwrapResult(originalFirst.value);
    const resubFirstEvent = unwrapResult(resubFirst.value);

    agent.mutate.resolve();
    await agent.mutated.promise;

    for (const event of [originalFirstEvent, resubFirstEvent]) {
      const artifact = event.artifact as {
        metadata: { details: { version: number } };
      };
      expect(artifact.metadata.details.version).toBe(1);
      expect(event.metadata).toEqual({ details: { sequence: 1 } });
    }

    const originalSecondPromise = originalIter.next();
    await originalSecondPromise;
    await Promise.all([
      (async () => {
        for await (const _ of originalIter) {
          // Drain until the publisher closes the task bus.
        }
      })(),
      (async () => {
        for await (const _ of resubIter) {
          // Drain queued updates and the terminal status.
        }
      })(),
    ]);
  });

  it('keeps publishing to a resubscriber after the primary SSE disconnects', async () => {
    const agent = new GatedTextAgent();
    const { handler, taskStore, a2xServer } = createHandler(agent, '1.0');
    const primaryDisconnect = new AbortController();
    const streamResult = await handler.handle(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: {
          message: {
            messageId: 'msg-drain',
            role: 'user',
            parts: [{ text: 'Hello' }],
          },
        },
      },
      { headers: {}, signal: primaryDisconnect.signal },
    );

    const primaryReader = createSSEStream(
      streamResult as AsyncGenerator<unknown>,
    ).getReader();
    const first = await primaryReader.read();
    expect(first.done).toBe(false);
    const firstEnvelope = JSON.parse(
      new TextDecoder()
        .decode(first.value)
        .replace(/^data: /, '')
        .trim(),
    ) as StreamEnvelope;
    const taskId = unwrapResult(firstEnvelope).taskId as string;
    const artifact = await primaryReader.read();
    expect(artifact.done).toBe(false);
    const artifactEnvelope = JSON.parse(
      new TextDecoder()
        .decode(artifact.value)
        .replace(/^data: /, '')
        .trim(),
    ) as StreamEnvelope;
    expect(unwrapResult(artifactEnvelope).artifact).toBeDefined();

    primaryDisconnect.abort();
    await primaryReader.cancel();
    expect(agent.capturedSignal?.aborted).toBe(false);

    const resubResult = await handler.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tasks/resubscribe',
      params: { id: taskId },
    });
    const resubIter = resubResult as AsyncGenerator<StreamEnvelope>;
    const resubEvents: Record<string, unknown>[] = [];
    const firstResubEvent = resubIter.next();
    expect(
      await waitUntil(() => a2xServer.taskEventBus.hasSubscribers(taskId)),
    ).toBe(true);

    const resubConsumer = (async () => {
      const firstEvent = await firstResubEvent;
      if (!firstEvent.done) {
        resubEvents.push(unwrapResult(firstEvent.value));
      }
      for await (const envelope of resubIter) {
        resubEvents.push(unwrapResult(envelope));
      }
    })();

    agent.release.resolve();
    agent.finish.resolve();
    await resubConsumer;

    expect(agent.capturedSignal?.aborted).toBe(false);
    expect(resubEvents.some((event) => event.artifact !== undefined)).toBe(true);
    expect(resubEvents.at(-1)?.status).toMatchObject({
      state: 'TASK_STATE_COMPLETED',
    });
    await expect(taskStore.getTask(taskId)).resolves.toMatchObject({
      status: { state: TaskState.COMPLETED },
    });
    expect(a2xServer.taskEventBus.hasSubscribers(taskId)).toBe(false);
  });

  it('detaches a disconnected passive resubscriber before task completion', async () => {
    const agent = new GatedTextAgent();
    const { handler, a2xServer } = createHandler(agent, '1.0');
    const primary = (await handler.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/stream',
      params: {
        message: {
          messageId: 'msg-passive-detach',
          role: 'user',
          parts: [{ text: 'Hello' }],
        },
      },
    })) as AsyncGenerator<StreamEnvelope>;
    const first = await primary.next();
    const taskId = unwrapResult(first.value).taskId as string;
    await primary.next();

    const resubDisconnect = new AbortController();
    const resub = await handler.handle(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/resubscribe',
        params: { id: taskId },
      },
      { headers: {}, signal: resubDisconnect.signal },
    );
    const resubReader = createSSEStream(
      resub as AsyncGenerator<unknown>,
    ).getReader();
    const pendingRead = resubReader.read();
    expect(await waitUntil(() => subscriberCount(a2xServer, taskId) === 2))
      .toBe(true);

    resubDisconnect.abort();
    await resubReader.cancel();
    await expect(pendingRead).resolves.toMatchObject({ done: true });
    expect(await waitUntil(() => subscriberCount(a2xServer, taskId) === 1))
      .toBe(true);

    agent.release.resolve();
    agent.finish.resolve();
    for await (const _event of primary) {
      // Drain the still-attached primary subscriber through terminal state.
    }
    expect(subscriberCount(a2xServer, taskId)).toBe(0);
  });

  it('still aborts drained execution through an explicit tasks/cancel request', async () => {
    const agent = new GatedTextAgent();
    const { handler, taskStore, a2xServer } = createHandler(agent, '1.0');
    const primaryDisconnect = new AbortController();
    const streamResult = await handler.handle(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: {
          message: {
            messageId: 'msg-cancel-drain',
            role: 'user',
            parts: [{ text: 'Hello' }],
          },
        },
      },
      { headers: {}, signal: primaryDisconnect.signal },
    );
    const primaryReader = createSSEStream(
      streamResult as AsyncGenerator<unknown>,
    ).getReader();
    const first = await primaryReader.read();
    const firstEnvelope = JSON.parse(
      new TextDecoder()
        .decode(first.value)
        .replace(/^data: /, '')
        .trim(),
    ) as StreamEnvelope;
    const taskId = unwrapResult(firstEnvelope).taskId as string;

    primaryDisconnect.abort();
    await primaryReader.cancel();
    const canceled = await handler.handle({
      jsonrpc: '2.0',
      id: 2,
      method: 'tasks/cancel',
      params: { id: taskId },
    });

    expect(canceled).toMatchObject({
      result: { status: { state: 'TASK_STATE_CANCELED' } },
    });
    expect(agent.capturedSignal?.aborted).toBe(true);
    agent.release.resolve();
    await agent.finished.promise;
    expect(
      await waitUntil(() => !a2xServer.taskEventBus.hasSubscribers(taskId)),
    ).toBe(true);
    await expect(taskStore.getTask(taskId)).resolves.toMatchObject({
      status: { state: TaskState.CANCELED },
    });
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
