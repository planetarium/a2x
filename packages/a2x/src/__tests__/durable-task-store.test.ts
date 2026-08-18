/**
 * Regression coverage for issue #233: handlers must persist every task
 * transition through the `TaskStore` contract instead of relying on the
 * store handing back a live object reference that `AgentExecutor`
 * mutates in place.
 *
 * Every test here runs against `CloneTaskStore`, which returns
 * deserialized snapshots the way a Postgres/Redis-backed store does. A
 * handler that only mutates the object it was given therefore leaves the
 * stored record untouched, and `tasks/get` diverges from the response the
 * caller already received.
 */
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DefaultRequestHandler } from '../transport/request-handler.js';
import { A2XServer } from '../a2x/a2x-agent.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { BaseAgent } from '../agent/base-agent.js';
import type { AgentEvent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';
import type {
  CreateTaskParams,
  TaskStore,
  TaskUpdate,
} from '../a2x/task-store.js';
import { TaskState, TERMINAL_STATES } from '../types/task.js';
import type {
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '../types/task.js';
import type {
  JSONRPCResponse,
  JSONRPCErrorResponse,
} from '../types/jsonrpc.js';
import { A2A_ERROR_CODES } from '../types/errors.js';

// Ensure mappers are registered
import '../a2x/index.js';

/**
 * A durable store stand-in: every value crossing the boundary is cloned,
 * so object identity never leaks. Keeps `InMemoryTaskStore`'s terminal
 * guard as well — a handler that writes the terminal transition twice
 * fails loudly instead of silently.
 */
class CloneTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>();

  /** Every update the handler wrote, in order, for write-shape assertions. */
  readonly writes: TaskUpdate[] = [];

  get ids(): string[] {
    return [...this.tasks.keys()];
  }

  /**
   * When set, the store refuses *any* write to a terminal task, not just a
   * status change. Durable stores are commonly this strict; a handler that
   * relies on patching a task after it terminated silently loses the data.
   */
  constructor(private readonly strictTerminal = false) {}

  async createTask(params: CreateTaskParams): Promise<Task> {
    const task: Task = {
      id: randomUUID(),
      contextId: params.contextId ?? randomUUID(),
      status: {
        state: TaskState.SUBMITTED,
        timestamp: new Date().toISOString(),
      },
      ...(params.metadata ? { metadata: params.metadata } : {}),
    };
    this.tasks.set(task.id, structuredClone(task));
    return structuredClone(task);
  }

  async getTask(taskId: string): Promise<Task | null> {
    const task = this.tasks.get(taskId);
    return task ? structuredClone(task) : null;
  }

  async updateTask(taskId: string, update: TaskUpdate): Promise<Task> {
    const current = this.tasks.get(taskId);
    if (!current) {
      throw new Error(`Task not found: ${taskId}`);
    }
    this.writes.push(structuredClone(update));
    if (
      (update.status || this.strictTerminal) &&
      TERMINAL_STATES.has(current.status.state)
    ) {
      throw new Error(
        `Cannot update task in terminal state '${current.status.state}': ${taskId}`,
      );
    }

    const next: Task = {
      ...current,
      ...(update.status ? { status: update.status } : {}),
      ...(update.artifacts ? { artifacts: update.artifacts } : {}),
      ...(update.history ? { history: update.history } : {}),
      ...(update.metadata
        ? { metadata: { ...current.metadata, ...update.metadata } }
        : {}),
    };
    this.tasks.set(taskId, structuredClone(next));
    return structuredClone(next);
  }

  async deleteTask(taskId: string): Promise<void> {
    this.tasks.delete(taskId);
  }
}

/**
 * Completes the task behind the handler's back between `tasks/cancel`'s
 * guard read and its write — the race the handler's terminal fallback
 * exists for. The guard therefore sees a stale, still-cancelable record.
 */
class RacingTaskStore extends CloneTaskStore {
  completeOnNextRead: string | undefined;

  override async getTask(taskId: string): Promise<Task | null> {
    const stale = await super.getTask(taskId);
    if (stale && this.completeOnNextRead === taskId) {
      this.completeOnNextRead = undefined;
      await super.updateTask(taskId, {
        status: {
          state: TaskState.COMPLETED,
          timestamp: new Date().toISOString(),
        },
      });
    }
    return stale;
  }
}

/** Cancels the task just before the handler's WORKING write lands. */
class CancelBeforeWorkingStore extends CloneTaskStore {
  private injected = false;

  override async updateTask(taskId: string, update: TaskUpdate): Promise<Task> {
    if (!this.injected && update.status?.state === TaskState.WORKING) {
      this.injected = true;
      await super.updateTask(taskId, {
        status: {
          state: TaskState.CANCELED,
          timestamp: new Date().toISOString(),
        },
      });
    }
    return super.updateTask(taskId, update);
  }
}

/** Simulates a recoverable outage on the first terminal write. */
class TerminalWriteFailsOnceStore extends CloneTaskStore {
  private failed = false;

  override async updateTask(taskId: string, update: TaskUpdate): Promise<Task> {
    if (
      !this.failed &&
      update.status &&
      TERMINAL_STATES.has(update.status.state)
    ) {
      this.failed = true;
      throw new Error('transient terminal write failure');
    }
    return super.updateTask(taskId, update);
  }
}

/** Simulates a transient outage on the initial WORKING write. */
class WorkingWriteFailsOnceStore extends CloneTaskStore {
  private failed = false;

  override async updateTask(taskId: string, update: TaskUpdate): Promise<Task> {
    if (!this.failed && update.status?.state === TaskState.WORKING) {
      this.failed = true;
      throw new Error('transient working write failure');
    }
    return super.updateTask(taskId, update);
  }
}

/** Simulates a persistent storage outage after task creation. */
class UpdateFailsStore extends CloneTaskStore {
  override async updateTask(): Promise<Task> {
    throw new Error('persistent update failure');
  }
}

/** Yields one text chunk, one data artifact, then completes. */
class EchoAgent extends BaseAgent {
  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    const text = context.message?.parts?.[0];
    yield {
      type: 'text',
      role: 'agent',
      text: text && 'text' in text ? `echo:${text.text}` : 'echo:',
    };
    yield { type: 'data', data: { ok: true } };
    yield { type: 'done', metadata: { 'test.receipt': 'r-1' } };
  }
}

/**
 * Turn 1 asks for input; turn 2 (the continuation carrying the token in
 * message metadata) completes with a receipt — the shape the x402
 * payment round trip takes in production.
 */
class TwoTurnAgent extends BaseAgent {
  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    const paid =
      (context.message?.metadata as { 'test.token'?: string } | undefined)
        ?.['test.token'] === 'tok-1';

    if (!paid) {
      yield {
        type: 'request-input',
        metadata: { 'test.required': true },
        message: 'Token required to continue.',
      };
      return;
    }

    yield { type: 'text', role: 'agent', text: 'settled' };
    yield { type: 'done', metadata: { 'test.receipt': 'r-1' } };
  }
}

/**
 * Emits the same *kinds* of artifact on both turns of a resume — the case
 * where a per-run id counter makes turn 2 collide with turn 1.
 */
class TwoTurnArtifactAgent extends BaseAgent {
  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    const resumed =
      (context.message?.metadata as { 'test.token'?: string } | undefined)
        ?.['test.token'] === 'tok-1';

    if (!resumed) {
      yield { type: 'data', data: { turn: 1 } };
      yield { type: 'text', role: 'agent', text: 'turn-1' };
      yield { type: 'request-input', metadata: { 'test.required': true } };
      return;
    }

    yield { type: 'data', data: { turn: 2 } };
    yield { type: 'text', role: 'agent', text: 'turn-2' };
    yield { type: 'done' };
  }
}

/** Blocks inside `run()` until the test releases it. */
class GatedAgent extends BaseAgent {
  readonly started = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();

  async *run(): AsyncGenerator<AgentEvent> {
    this.started.resolve();
    await this.release.promise;
    yield { type: 'text', role: 'agent', text: 'late' };
    yield { type: 'done' };
  }
}

class CountingAgent extends BaseAgent {
  runs = 0;

  async *run(): AsyncGenerator<AgentEvent> {
    this.runs++;
    yield { type: 'done' };
  }
}

class ErrorAfterArtifactsAgent extends BaseAgent {
  async *run(): AsyncGenerator<AgentEvent> {
    yield { type: 'text', role: 'agent', text: 'before-error' };
    yield { type: 'data', data: { retained: true } };
    yield { type: 'error', error: new Error('failed intentionally') };
  }
}

class ImplicitCompletionAgent extends BaseAgent {
  async *run(): AsyncGenerator<AgentEvent> {
    yield { type: 'text', role: 'agent', text: 'implicit' };
    yield { type: 'data', data: { retained: true } };
  }
}

class AbortThenReturnAgent extends BaseAgent {
  readonly started = Promise.withResolvers<void>();

  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    this.started.resolve();
    await new Promise<void>((resolve) => {
      if (context.signal?.aborted) resolve();
      else context.signal?.addEventListener('abort', () => resolve(), { once: true });
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

class CompletingCancelExecutor extends AgentExecutor {
  override async cancel(task: Task): Promise<Task> {
    task.status = {
      state: TaskState.COMPLETED,
      timestamp: new Date().toISOString(),
    };
    return task;
  }
}

class NonTerminalCancelExecutor extends AgentExecutor {
  override async cancel(task: Task): Promise<Task> {
    task.status = {
      state: TaskState.WORKING,
      timestamp: new Date().toISOString(),
    };
    return task;
  }
}

class ProgressiveArtifactExecutor extends AgentExecutor {
  override async *executeStream(
    task: Task,
  ): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    const contextId = task.contextId ?? task.id;
    task.artifacts = [
      { artifactId: 'canonical', parts: [{ text: 'canonical' }] },
    ];
    yield {
      taskId: task.id,
      contextId,
      status: { state: TaskState.WORKING },
      final: false,
    };
    yield {
      taskId: task.id,
      contextId,
      artifact: { artifactId: 'later', parts: [{ text: 'later' }] },
      append: false,
      lastChunk: true,
    };
    yield {
      taskId: task.id,
      contextId,
      status: { state: TaskState.COMPLETED },
      final: true,
    };
  }
}

class SessionCreationFailsRunner extends InMemoryRunner {
  override async createSession(): Promise<never> {
    throw new Error('session setup failed');
  }
}

class GatedSessionRunner extends InMemoryRunner {
  readonly started = Promise.withResolvers<void>();
  readonly release = Promise.withResolvers<void>();

  override async createSession() {
    this.started.resolve();
    await this.release.promise;
    return super.createSession();
  }
}

function createServerWithRunner(
  runner: InMemoryRunner,
  store = new CloneTaskStore(),
): {
  taskStore: CloneTaskStore;
  handler: DefaultRequestHandler;
} {
  const server = new A2XServer({
    taskStore: store,
    executor: new AgentExecutor({
      runner,
      runConfig: { streamingMode: StreamingMode.SSE },
    }),
    protocolVersion: '0.3',
  });
  server.setDefaultUrl('https://example.com/a2a');
  return { taskStore: store, handler: new DefaultRequestHandler(server) };
}

function createServerWithStore(
  agent: BaseAgent,
  store?: CloneTaskStore,
): {
  taskStore: CloneTaskStore;
  a2xServer: A2XServer;
  handler: DefaultRequestHandler;
} {
  const taskStore = store ?? new CloneTaskStore();
  const runner = new InMemoryRunner({ agent, appName: 'durable-test' });
  const executor = new AgentExecutor({
    runner,
    runConfig: { streamingMode: StreamingMode.SSE },
  });
  // v0.3 wire shape: lower-case task states, `kind`-tagged parts.
  const a2xServer = new A2XServer({ taskStore, executor, protocolVersion: '0.3' });
  a2xServer.setDefaultUrl('https://example.com/a2a');
  return { taskStore, a2xServer, handler: new DefaultRequestHandler(a2xServer) };
}

type WireTask = {
  id: string;
  status: { state: string; message?: { metadata?: Record<string, unknown> } };
  artifacts?: Array<{ artifactId: string; parts: Array<Record<string, unknown>> }>;
};

async function send(
  handler: DefaultRequestHandler,
  params: Record<string, unknown>,
): Promise<WireTask> {
  const response = (await handler.handle({
    jsonrpc: '2.0',
    id: 1,
    method: 'message/send',
    params,
  })) as JSONRPCResponse;
  if (!('result' in response)) {
    throw new Error(`message/send failed: ${JSON.stringify(response)}`);
  }
  return response.result as WireTask;
}

async function getTask(
  handler: DefaultRequestHandler,
  id: string,
): Promise<WireTask> {
  const response = (await handler.handle({
    jsonrpc: '2.0',
    id: 2,
    method: 'tasks/get',
    params: { id },
  })) as JSONRPCResponse;
  if (!('result' in response)) {
    throw new Error(`tasks/get failed: ${JSON.stringify(response)}`);
  }
  return response.result as WireTask;
}

function userMessage(
  text: string,
  extra?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    messageId: randomUUID(),
    role: 'user',
    parts: [{ kind: 'text', text }],
    ...extra,
  };
}

/**
 * `handle()` yields fully-formed JSON-RPC envelopes for streaming
 * methods; the events under test live in `result`.
 */
async function drain(
  stream: AsyncGenerator<unknown>,
): Promise<Array<Record<string, unknown>>> {
  const events: Array<Record<string, unknown>> = [];
  for await (const envelope of stream) {
    const { result } = envelope as { result: Record<string, unknown> };
    events.push(result);
  }
  return events;
}

function expectUniqueArtifactIds(task: WireTask): void {
  const ids = (task.artifacts ?? []).map((a) => a.artifactId);
  expect(new Set(ids).size).toBe(ids.length);
}

function dataOf(task: WireTask): unknown[] {
  return (task.artifacts ?? []).flatMap((a) =>
    a.parts.filter((p) => p.data !== undefined).map((p) => p.data),
  );
}

function textOf(task: WireTask): string[] {
  return (task.artifacts ?? []).flatMap((a) =>
    a.parts.filter((p) => typeof p.text === 'string').map((p) => p.text as string),
  );
}

describe('durable TaskStore persistence (issue #233)', () => {
  describe('blocking message/send', () => {
    it('persists the terminal status and artifacts', async () => {
      const { handler } = createServerWithStore(new EchoAgent({ name: 'echo' }));

      const sent = await send(handler, { message: userMessage('hi') });
      expect(sent.status.state).toBe(TaskState.COMPLETED);

      const fetched = await getTask(handler, sent.id);
      expect(fetched.status.state).toBe(TaskState.COMPLETED);
      expect(textOf(fetched)).toEqual(['echo:hi']);
      expect(fetched.artifacts).toHaveLength(2);
    });

    it('persists terminal status-message metadata', async () => {
      const { handler } = createServerWithStore(new EchoAgent({ name: 'echo' }));

      const sent = await send(handler, { message: userMessage('hi') });
      expect(sent.status.message?.metadata).toMatchObject({
        'test.receipt': 'r-1',
      });

      const fetched = await getTask(handler, sent.id);
      expect(fetched.status.message?.metadata).toMatchObject({
        'test.receipt': 'r-1',
      });
    });

    it('returns the same task the store holds', async () => {
      const { handler } = createServerWithStore(new EchoAgent({ name: 'echo' }));

      const sent = await send(handler, { message: userMessage('hi') });
      const fetched = await getTask(handler, sent.id);

      expect(fetched.status).toEqual(sent.status);
      expect(fetched.artifacts).toEqual(sent.artifacts);
    });

    it('persists input-required and the continuation that follows it', async () => {
      const { handler } = createServerWithStore(
        new TwoTurnAgent({ name: 'two-turn' }),
      );

      const first = await send(handler, { message: userMessage('buy') });
      expect(first.status.state).toBe(TaskState.INPUT_REQUIRED);

      const parked = await getTask(handler, first.id);
      expect(parked.status.state).toBe(TaskState.INPUT_REQUIRED);
      expect(parked.status.message?.metadata).toMatchObject({
        'test.required': true,
      });

      const second = await send(handler, {
        message: userMessage('paid', {
          taskId: first.id,
          metadata: { 'test.token': 'tok-1' },
        }),
      });
      expect(second.id).toBe(first.id);
      expect(second.status.state).toBe(TaskState.COMPLETED);

      const settled = await getTask(handler, first.id);
      expect(settled.status.state).toBe(TaskState.COMPLETED);
      expect(settled.status.message?.metadata).toMatchObject({
        'test.receipt': 'r-1',
      });
      expect(textOf(settled)).toEqual(['settled']);
    });

    it('survives a fresh handler over the same store', async () => {
      const agent = new TwoTurnAgent({ name: 'two-turn' });
      const first = createServerWithStore(agent);

      const parked = await send(first.handler, { message: userMessage('buy') });
      expect(parked.status.state).toBe(TaskState.INPUT_REQUIRED);

      // A different replica picks the task up — it can only see what was
      // written to the store.
      const runner = new InMemoryRunner({ agent, appName: 'durable-test' });
      const replica = new A2XServer({
        taskStore: first.taskStore,
        executor: new AgentExecutor({
          runner,
          runConfig: { streamingMode: StreamingMode.SSE },
        }),
        protocolVersion: '0.3',
      });
      replica.setDefaultUrl('https://example.com/a2a');
      const replicaHandler = new DefaultRequestHandler(replica);

      const settled = await send(replicaHandler, {
        message: userMessage('paid', {
          taskId: parked.id,
          metadata: { 'test.token': 'tok-1' },
        }),
      });
      expect(settled.id).toBe(parked.id);
      expect(settled.status.state).toBe(TaskState.COMPLETED);

      const fetched = await getTask(first.handler, parked.id);
      expect(fetched.status.state).toBe(TaskState.COMPLETED);
      expect(textOf(fetched)).toEqual(['settled']);
    });

    it('retains artifacts produced before a failed terminal result', async () => {
      const { handler } = createServerWithStore(
        new ErrorAfterArtifactsAgent({ name: 'error-after-artifacts' }),
      );

      const failed = await send(handler, { message: userMessage('fail') });
      expect(failed.status.state).toBe(TaskState.FAILED);
      expect(textOf(failed)).toEqual(['before-error']);
      expect(dataOf(failed)).toEqual([{ retained: true }]);

      const fetched = await getTask(handler, failed.id);
      expect(fetched.artifacts).toEqual(failed.artifacts);
    });

    it('finalizes text and data when the agent returns without done', async () => {
      const { handler } = createServerWithStore(
        new ImplicitCompletionAgent({ name: 'implicit-completion' }),
      );

      const completed = await send(handler, { message: userMessage('finish') });
      expect(completed.status.state).toBe(TaskState.COMPLETED);
      expect(textOf(completed)).toEqual(['implicit']);
      expect(dataOf(completed)).toEqual([{ retained: true }]);
    });

    it('persists failed when session creation throws', async () => {
      const agent = new CountingAgent({ name: 'counting' });
      const { handler } = createServerWithRunner(
        new SessionCreationFailsRunner({ agent, appName: 'durable-test' }),
      );

      const failed = await send(handler, { message: userMessage('fail') });
      expect(failed.status.state).toBe(TaskState.FAILED);
      expect(agent.runs).toBe(0);

      const fetched = await getTask(handler, failed.id);
      expect(fetched.status.state).toBe(TaskState.FAILED);
    });
  });

  describe('message/stream', () => {
    it('persists the terminal status and accumulated artifacts', async () => {
      const { handler } = createServerWithStore(new EchoAgent({ name: 'echo' }));

      const stream = (await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: { message: userMessage('hi') },
      })) as AsyncGenerator<unknown>;

      const events = await drain(stream);
      const taskId = events[0]!.taskId as string;
      const fetched = await getTask(handler, taskId);

      expect(fetched.status.state).toBe(TaskState.COMPLETED);
      expect(fetched.status.message?.metadata).toMatchObject({
        'test.receipt': 'r-1',
      });
      // Streamed text chunks fold into a single artifact rather than
      // accumulating one entry per chunk.
      expect(textOf(fetched)).toEqual(['echo:hi']);
      expect(fetched.artifacts).toHaveLength(2);
    });

    it('persists input-required reached mid-stream', async () => {
      const { handler } = createServerWithStore(
        new TwoTurnAgent({ name: 'two-turn' }),
      );

      const stream = (await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: { message: userMessage('buy') },
      })) as AsyncGenerator<unknown>;

      const events = await drain(stream);
      const taskId = events[0]!.taskId as string;
      const fetched = await getTask(handler, taskId);
      expect(fetched.status.state).toBe(TaskState.INPUT_REQUIRED);
      expect(fetched.status.message?.metadata).toMatchObject({
        'test.required': true,
      });
      expect(events.at(-1)?.final).toBe(true);

      const replay = await drain(
        (await handler.handle({
          jsonrpc: '2.0',
          id: 2,
          method: 'tasks/resubscribe',
          params: { id: taskId },
        })) as AsyncGenerator<unknown>,
      );
      expect(replay).toHaveLength(1);
      expect(replay[0]!.status).toMatchObject({
        state: TaskState.INPUT_REQUIRED,
      });
      expect(replay[0]!.final).toBe(true);
    });

    it('retains artifacts produced before a failed terminal result', async () => {
      const { handler } = createServerWithStore(
        new ErrorAfterArtifactsAgent({ name: 'error-after-artifacts' }),
      );

      const events = await drain(
        (await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/stream',
          params: { message: userMessage('fail') },
        })) as AsyncGenerator<unknown>,
      );
      const statusEvents = events.filter((event) => event.kind === 'status-update');
      expect(statusEvents.map((event) => event.final)).toEqual([false, true]);

      const fetched = await getTask(handler, events[0]!.taskId as string);
      expect(fetched.status.state).toBe(TaskState.FAILED);
      expect(textOf(fetched)).toEqual(['before-error']);
      expect(dataOf(fetched)).toEqual([{ retained: true }]);
    });

    it('synthesizes a terminal event when the agent returns without done', async () => {
      const { handler } = createServerWithStore(
        new ImplicitCompletionAgent({ name: 'implicit-completion' }),
      );

      const events = await drain(
        (await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/stream',
          params: { message: userMessage('finish') },
        })) as AsyncGenerator<unknown>,
      );
      const terminal = events.at(-1)!;
      expect(terminal.status).toMatchObject({ state: TaskState.COMPLETED });
      expect(terminal.final).toBe(true);

      const fetched = await getTask(handler, events[0]!.taskId as string);
      expect(fetched.status.state).toBe(TaskState.COMPLETED);
      expect(textOf(fetched)).toEqual(['implicit']);
      expect(dataOf(fetched)).toEqual([{ retained: true }]);
    });

    it('persists a final failed event when session creation throws', async () => {
      const agent = new CountingAgent({ name: 'counting' });
      const { handler, taskStore } = createServerWithRunner(
        new SessionCreationFailsRunner({ agent, appName: 'durable-test' }),
      );

      const events = await drain(
        (await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/stream',
          params: { message: userMessage('fail') },
        })) as AsyncGenerator<unknown>,
      );

      expect(events).toHaveLength(1);
      expect(events[0]!.status).toMatchObject({ state: TaskState.FAILED });
      expect(events[0]!.final).toBe(true);
      expect(agent.runs).toBe(0);
      const stored = await taskStore.getTask(taskStore.ids[0]!);
      expect(stored!.status.state).toBe(TaskState.FAILED);
    });
  });

  describe('write discipline', () => {
    it('persists the working transition before the agent runs', async () => {
      const agent = new GatedAgent({ name: 'gated' });
      const { handler, taskStore } = createServerWithStore(agent);

      const inFlight = send(handler, { message: userMessage('hi') });
      await agent.started.promise;

      // A long blocking execution must be observable as `working` rather
      // than looking like it was never picked up.
      const fetched = await getTask(handler, taskStore.ids[0]!);
      expect(fetched.status.state).toBe(TaskState.WORKING);

      agent.release.resolve();
      await inFlight;
    });

    it('carries the artifacts in the terminal write itself', async () => {
      // Strict store: any write to a terminal task is rejected, so a
      // terminal status write that omits artifacts loses them for good.
      const store = new CloneTaskStore(true);
      const { handler } = createServerWithStore(
        new EchoAgent({ name: 'echo' }),
        store,
      );

      const stream = (await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: { message: userMessage('hi') },
      })) as AsyncGenerator<unknown>;
      const events = await drain(stream);

      const terminalWrite = store.writes.at(-1)!;
      expect(terminalWrite.status?.state).toBe(TaskState.COMPLETED);
      expect(terminalWrite.artifacts).toHaveLength(2);

      const fetched = await getTask(handler, events[0]!.taskId as string);
      expect(textOf(fetched)).toEqual(['echo:hi']);
    });

    it('persists delivered artifacts and cancels when the client disconnects', async () => {
      const { handler, taskStore } = createServerWithStore(
        new EchoAgent({ name: 'echo' }),
      );

      const stream = (await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: { message: userMessage('hi') },
      })) as AsyncGenerator<unknown>;

      // Consume the `working` status and the first artifact chunk, then
      // walk away. The delivered chunk must already be durable, and the
      // abandoned execution must not remain a WORKING zombie.
      const first = (await stream.next()).value as { result: WireTask };
      await stream.next();
      await stream.return(undefined);

      const taskId = (first.result as unknown as { taskId: string }).taskId;
      const stored = await taskStore.getTask(taskId);
      expect(stored!.status.state).toBe(TaskState.CANCELED);
      expect(stored!.artifacts).toHaveLength(1);

      const replay = await drain(
        (await handler.handle({
          jsonrpc: '2.0',
          id: 2,
          method: 'tasks/resubscribe',
          params: { id: taskId },
        })) as AsyncGenerator<unknown>,
      );
      expect(replay).toHaveLength(1);
      expect(replay[0]!.status).toMatchObject({ state: TaskState.CANCELED });
      expect(replay[0]!.final).toBe(true);
    });

    it('does not execute after cancellation wins the WORKING write race', async () => {
      const store = new CancelBeforeWorkingStore();
      const agent = new CountingAgent({ name: 'counting' });
      const { handler } = createServerWithStore(agent, store);

      const result = await send(handler, { message: userMessage('hi') });

      expect(result.status.state).toBe(TaskState.CANCELED);
      expect(agent.runs).toBe(0);
    });

    it('streams the authoritative canceled state when it wins the WORKING write race', async () => {
      const store = new CancelBeforeWorkingStore();
      const agent = new CountingAgent({ name: 'counting' });
      const { handler } = createServerWithStore(agent, store);

      const events = await drain(
        (await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/stream',
          params: { message: userMessage('hi') },
        })) as AsyncGenerator<unknown>,
      );

      expect(events).toHaveLength(1);
      expect(events[0]!.status).toMatchObject({ state: TaskState.CANCELED });
      expect(events[0]!.final).toBe(true);
      expect(agent.runs).toBe(0);
    });

    it('does not synthesize completed after an active stream is canceled', async () => {
      const agent = new AbortThenReturnAgent({ name: 'abort-then-return' });
      const { handler, taskStore } = createServerWithStore(agent);
      const stream = (await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: { message: userMessage('hi') },
      })) as AsyncGenerator<unknown>;

      const working = await stream.next();
      expect(working.done).toBe(false);
      const pending = stream.next();
      await agent.started.promise;
      const taskId = taskStore.ids[0]!;

      const canceled = (await handler.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/cancel',
        params: { id: taskId },
      })) as JSONRPCResponse;
      expect('result' in canceled).toBe(true);
      const terminal = await pending;
      expect(terminal.done).toBe(false);
      expect(
        (terminal.value as { result: Record<string, unknown> }).result.status,
      ).toMatchObject({ state: TaskState.CANCELED });
      expect(
        (terminal.value as { result: Record<string, unknown> }).result.final,
      ).toBe(true);
      expect(await stream.next()).toMatchObject({ done: true });

      const stored = await taskStore.getTask(taskId);
      expect(stored!.status.state).toBe(TaskState.CANCELED);
    });

    it('does not enter the agent when canceled during session creation', async () => {
      const agent = new CountingAgent({ name: 'counting' });
      const runner = new GatedSessionRunner({
        agent,
        appName: 'durable-test',
      });
      const { handler, taskStore } = createServerWithRunner(runner);
      const stream = (await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: { message: userMessage('hi') },
      })) as AsyncGenerator<unknown>;

      const pending = stream.next();
      await runner.started.promise;
      const taskId = taskStore.ids[0]!;
      const canceled = (await handler.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/cancel',
        params: { id: taskId },
      })) as JSONRPCResponse;
      runner.release.resolve();

      expect('result' in canceled).toBe(true);
      const terminal = await pending;
      expect(terminal.done).toBe(false);
      expect(
        (terminal.value as { result: Record<string, unknown> }).result.status,
      ).toMatchObject({ state: TaskState.CANCELED });
      expect(await stream.next()).toMatchObject({ done: true });
      expect(agent.runs).toBe(0);
    });

    it('retains an artifact delivered before strict-store cancellation', async () => {
      const store = new CloneTaskStore(true);
      const { handler } = createServerWithStore(
        new EchoAgent({ name: 'echo' }),
        store,
      );
      const stream = (await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: { message: userMessage('hi') },
      })) as AsyncGenerator<unknown>;

      await stream.next();
      await stream.next();
      const taskId = store.ids[0]!;
      const beforeCancel = await store.getTask(taskId);
      expect(beforeCancel!.artifacts).toHaveLength(1);

      const canceled = (await handler.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/cancel',
        params: { id: taskId },
      })) as JSONRPCResponse;
      expect('result' in canceled).toBe(true);
      await stream.return(undefined);

      const stored = await store.getTask(taskId);
      expect(stored!.status.state).toBe(TaskState.CANCELED);
      expect(textOf(stored as unknown as WireTask)).toEqual(['echo:hi']);
    });

    it('keeps custom executor artifacts added after a canonical snapshot', async () => {
      const store = new CloneTaskStore();
      const agent = new CountingAgent({ name: 'counting' });
      const runner = new InMemoryRunner({ agent, appName: 'durable-test' });
      const server = new A2XServer({
        taskStore: store,
        executor: new ProgressiveArtifactExecutor({
          runner,
          runConfig: { streamingMode: StreamingMode.SSE },
        }),
        protocolVersion: '0.3',
      });
      server.setDefaultUrl('https://example.com/a2a');
      const handler = new DefaultRequestHandler(server);

      await drain(
        (await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/stream',
          params: { message: userMessage('hi') },
        })) as AsyncGenerator<unknown>,
      );

      const stored = await store.getTask(store.ids[0]!);
      expect(textOf(stored as unknown as WireTask)).toEqual([
        'canonical',
        'later',
      ]);
    });

    it('flushes artifacts when the terminal write fails transiently', async () => {
      const store = new TerminalWriteFailsOnceStore();
      const { handler } = createServerWithStore(
        new EchoAgent({ name: 'echo' }),
        store,
      );
      const stream = (await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: { message: userMessage('hi') },
      })) as AsyncGenerator<unknown>;

      // The handler converts the stream failure into a final JSON-RPC error
      // envelope; draining still exercises the generator's `finally` block.
      await drain(stream);

      const stored = await store.getTask(store.ids[0]!);
      expect(stored!.status.state).toBe(TaskState.COMPLETED);
      expect(stored!.artifacts).toHaveLength(2);
    });

    it('does not record canceled when the stream fails server-side', async () => {
      const store = new UpdateFailsStore();
      const { handler } = createServerWithStore(
        new EchoAgent({ name: 'echo' }),
        store,
      );
      const stream = (await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: { message: userMessage('hi') },
      })) as AsyncGenerator<unknown>;

      const envelope = (await stream.next()).value as JSONRPCResponse;
      expect('error' in envelope).toBe(true);

      const stored = await store.getTask(store.ids[0]!);
      expect(stored!.status.state).toBe(TaskState.SUBMITTED);
    });

    it('does not retry a failed WORKING write into a zombie state', async () => {
      const store = new WorkingWriteFailsOnceStore();
      const { handler } = createServerWithStore(
        new EchoAgent({ name: 'echo' }),
        store,
      );
      const stream = (await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/stream',
        params: { message: userMessage('hi') },
      })) as AsyncGenerator<unknown>;

      const envelope = (await stream.next()).value as JSONRPCResponse;
      expect('error' in envelope).toBe(true);

      const stored = await store.getTask(store.ids[0]!);
      expect(stored!.status.state).toBe(TaskState.SUBMITTED);
      expect(store.writes).toHaveLength(0);
    });
  });

  describe('artifacts across turns', () => {
    it('persists the same artifact order for blocking and streaming', async () => {
      const blocking = createServerWithStore(new EchoAgent({ name: 'echo' }));
      const sent = await send(blocking.handler, { message: userMessage('hi') });

      const streaming = createServerWithStore(new EchoAgent({ name: 'echo' }));
      const events = await drain(
        (await streaming.handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/stream',
          params: { message: userMessage('hi') },
        })) as AsyncGenerator<unknown>,
      );
      const streamed = await getTask(
        streaming.handler,
        events[0]!.taskId as string,
      );

      const suffixes = (task: WireTask, id: string) =>
        (task.artifacts ?? []).map((artifact) =>
          artifact.artifactId.replace(id, '<task>'),
        );
      expect(suffixes(streamed, streamed.id)).toEqual(suffixes(sent, sent.id));
    });

    it('keeps earlier-turn artifacts when a continuation completes (blocking)', async () => {
      const { handler } = createServerWithStore(
        new TwoTurnArtifactAgent({ name: 'two-turn-artifacts' }),
      );

      const parked = await send(handler, { message: userMessage('buy') });
      expect(parked.status.state).toBe(TaskState.INPUT_REQUIRED);

      const settled = await send(handler, {
        message: userMessage('paid', {
          taskId: parked.id,
          metadata: { 'test.token': 'tok-1' },
        }),
      });
      expect(settled.status.state).toBe(TaskState.COMPLETED);

      // Turn 2 must not erase what turn 1 already produced, and must not
      // reuse its artifact ids to do it.
      const fetched = await getTask(handler, parked.id);
      expect(dataOf(fetched)).toEqual([{ turn: 1 }, { turn: 2 }]);
      expect(textOf(fetched)).toEqual(['turn-1', 'turn-2']);
      expectUniqueArtifactIds(fetched);
    });

    it('keeps earlier-turn artifacts when a continuation completes (streaming)', async () => {
      const { handler } = createServerWithStore(
        new TwoTurnArtifactAgent({ name: 'two-turn-artifacts' }),
      );

      const first = await drain(
        (await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/stream',
          params: { message: userMessage('buy') },
        })) as AsyncGenerator<unknown>,
      );
      const taskId = first[0]!.taskId as string;

      await drain(
        (await handler.handle({
          jsonrpc: '2.0',
          id: 2,
          method: 'message/stream',
          params: {
            message: userMessage('paid', {
              taskId,
              metadata: { 'test.token': 'tok-1' },
            }),
          },
        })) as AsyncGenerator<unknown>,
      );

      const fetched = await getTask(handler, taskId);
      expect(fetched.status.state).toBe(TaskState.COMPLETED);
      expect(dataOf(fetched)).toEqual([{ turn: 1 }, { turn: 2 }]);
      expect(textOf(fetched)).toEqual(['turn-1', 'turn-2']);
      expectUniqueArtifactIds(fetched);
    });

    it('allocates the same ids for a resumed turn on either transport', async () => {
      const blocking = createServerWithStore(
        new TwoTurnArtifactAgent({ name: 'two-turn-artifacts' }),
      );
      const parked = await send(blocking.handler, { message: userMessage('buy') });
      await send(blocking.handler, {
        message: userMessage('paid', {
          taskId: parked.id,
          metadata: { 'test.token': 'tok-1' },
        }),
      });
      const viaSend = await getTask(blocking.handler, parked.id);

      const streaming = createServerWithStore(
        new TwoTurnArtifactAgent({ name: 'two-turn-artifacts' }),
      );
      const first = await drain(
        (await streaming.handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'message/stream',
          params: { message: userMessage('buy') },
        })) as AsyncGenerator<unknown>,
      );
      const streamedId = first[0]!.taskId as string;
      await drain(
        (await streaming.handler.handle({
          jsonrpc: '2.0',
          id: 2,
          method: 'message/stream',
          params: {
            message: userMessage('paid', {
              taskId: streamedId,
              metadata: { 'test.token': 'tok-1' },
            }),
          },
        })) as AsyncGenerator<unknown>,
      );
      const viaStream = await getTask(streaming.handler, streamedId);

      const suffixes = (task: WireTask, id: string) =>
        (task.artifacts ?? []).map((a) => a.artifactId.replace(id, '<task>'));
      expect(suffixes(viaStream, streamedId)).toEqual(
        suffixes(viaSend, parked.id),
      );
    });
  });

  describe('tasks/cancel', () => {
    it('persists the canceled status', async () => {
      const { handler, taskStore } = createServerWithStore(
        new TwoTurnAgent({ name: 'two-turn' }),
      );

      const parked = await send(handler, { message: userMessage('buy') });

      const response = (await handler.handle({
        jsonrpc: '2.0',
        id: 3,
        method: 'tasks/cancel',
        params: { id: parked.id },
      })) as JSONRPCResponse;
      expect('result' in response).toBe(true);

      const stored = await taskStore.getTask(parked.id);
      expect(stored?.status.state).toBe(TaskState.CANCELED);

      const fetched = await getTask(handler, parked.id);
      expect(fetched.status.state).toBe(TaskState.CANCELED);
    });

    it('reports not-cancelable when the task terminates during the cancel', async () => {
      const store = new RacingTaskStore();
      const { handler } = createServerWithStore(
        new TwoTurnAgent({ name: 'two-turn' }),
        store,
      );

      const parked = await send(handler, { message: userMessage('buy') });
      store.completeOnNextRead = parked.id;

      const response = (await handler.handle({
        jsonrpc: '2.0',
        id: 3,
        method: 'tasks/cancel',
        params: { id: parked.id },
      })) as JSONRPCResponse;

      // A cancel that lost the race must not answer with success — and
      // must not overwrite the terminal state that won.
      expect('error' in response).toBe(true);
      expect((response as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.TASK_NOT_CANCELABLE,
      );
      const stored = await store.getTask(parked.id);
      expect(stored!.status.state).toBe(TaskState.COMPLETED);
    });

    it('accepts the terminal state returned by a custom cancel implementation', async () => {
      const store = new CloneTaskStore();
      const agent = new TwoTurnAgent({ name: 'two-turn' });
      const runner = new InMemoryRunner({ agent, appName: 'durable-test' });
      const server = new A2XServer({
        taskStore: store,
        executor: new CompletingCancelExecutor({
          runner,
          runConfig: { streamingMode: StreamingMode.SSE },
        }),
        protocolVersion: '0.3',
      });
      server.setDefaultUrl('https://example.com/a2a');
      const handler = new DefaultRequestHandler(server);
      const parked = await send(handler, { message: userMessage('buy') });

      const response = (await handler.handle({
        jsonrpc: '2.0',
        id: 3,
        method: 'tasks/cancel',
        params: { id: parked.id },
      })) as JSONRPCResponse;

      expect('result' in response).toBe(true);
      const stored = await store.getTask(parked.id);
      expect(stored!.status.state).toBe(TaskState.COMPLETED);
    });

    it('rejects a non-terminal state returned by a custom cancel implementation', async () => {
      const store = new CloneTaskStore();
      const agent = new TwoTurnAgent({ name: 'two-turn' });
      const runner = new InMemoryRunner({ agent, appName: 'durable-test' });
      const server = new A2XServer({
        taskStore: store,
        executor: new NonTerminalCancelExecutor({
          runner,
          runConfig: { streamingMode: StreamingMode.SSE },
        }),
        protocolVersion: '0.3',
      });
      server.setDefaultUrl('https://example.com/a2a');
      const handler = new DefaultRequestHandler(server);
      const parked = await send(handler, { message: userMessage('buy') });

      const response = (await handler.handle({
        jsonrpc: '2.0',
        id: 3,
        method: 'tasks/cancel',
        params: { id: parked.id },
      })) as JSONRPCResponse;

      expect('error' in response).toBe(true);
      expect((response as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.TASK_NOT_CANCELABLE,
      );
      const stored = await store.getTask(parked.id);
      expect(stored!.status.state).toBe(TaskState.WORKING);
    });
  });
});
