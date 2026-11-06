import { describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { BaseAgent, type AgentEvent } from '../agent/base-agent.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { A2XServer } from '../a2x/a2x-agent.js';
import { InMemoryTaskStore } from '../a2x/task-store.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { DefaultRequestHandler } from '../transport/request-handler.js';
import { HttpJsonRequestHandler } from '../transport/http-json-handler.js';
import { createA2xRequestListener } from '../transport/to-a2x.js';
import { TaskState, type Task } from '../types/task.js';
import { ApiKeyAuthorization } from '../security/api-key.js';
import { InMemoryPushNotificationConfigStore } from '../a2x/push-notification-config-store.js';
import type { JSONRPCSuccessResponse } from '../types/jsonrpc.js';
import '../a2x/index.js';

class UnusedAgent extends BaseAgent {
  constructor() { super({ name: 'unary-only' }); }
  async *run(): AsyncGenerator<AgentEvent> { throw new Error('Use the unary override'); }
}

function latch() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

function fixture(version: '0.3' | '1.0' = '0.3') {
  const store = new InMemoryTaskStore();
  const gate = latch();
  const started = latch();
  const executor = new AgentExecutor({
    runner: new InMemoryRunner({ agent: new UnusedAgent(), appName: 'nonblocking' }),
    runConfig: { streamingMode: StreamingMode.NONE },
  });
  const context = new AsyncLocalStorage<string>();
  let taskId = '';
  const execute = vi.spyOn(executor, 'execute').mockImplementation(async (task) => {
    taskId = task.id;
    started.release();
    await gate.promise;
    expect(context.getStore()).toBe('caller-scope');
    return {
      ...task,
      status: { state: TaskState.COMPLETED },
      artifacts: [{ artifactId: 'file', parts: [{ raw: Buffer.from('actual-file-bytes').toString('base64'), filename: 'result.txt' }] }],
    };
  });
  const pushStore = new InMemoryPushNotificationConfigStore();
  const push = vi.fn(async () => {});
  const server = new A2XServer({ taskStore: store, executor, protocolVersion: version,
    pushNotificationConfigStore: pushStore, pushNotificationSender: { send: push } })
    .setName('nonblocking-test')
    .setDescription('Synthetic gated unary executor')
    .setVersion('1')
    .setDefaultUrl('http://localhost/a2a');
  const handler = new DefaultRequestHandler(server);
  const send = (configuration: Record<string, unknown> | undefined = { blocking: false }, extra = {}) =>
    context.run('caller-scope', () => handler.handle({
      jsonrpc: '2.0', id: 1, method: version === '0.3' ? 'message/send' : 'SendMessage',
      params: {
        message: { messageId: 'message-1', role: 'user', parts: [{ text: 'work' }], ...extra },
        configuration,
      },
    })) as Promise<JSONRPCSuccessResponse>;
  return { store, gate, started, executor, execute, handler, server, context, send, push, taskId: () => taskId };
}

async function terminal(store: InMemoryTaskStore, id: string, state = TaskState.COMPLETED) {
  await vi.waitFor(async () => expect((await store.getTask(id))?.status.state).toBe(state));
  return (await store.getTask(id))!;
}

describe('nonblocking message/send', () => {
  it.each(['0.3', '1.0', 'http-json'] as const)('acknowledges before completion and survives HTTP response closure: %s', async (binding) => {
    const f = fixture(binding === '0.3' ? '0.3' : '1.0');
    const listener = createA2xRequestListener(f.handler, 'http://localhost', {
      httpJsonHandler: new HttpJsonRequestHandler(f.handler, { basePath: '/a2a' }),
    });
    const http = createServer((req, res) => f.context.run('caller-scope', () => listener(req, res)));
    await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(http.address() as AddressInfo).port}/a2a`;
    const controller = new AbortController();
    const params = {
      message: { messageId: 'http-message', role: binding === '0.3' ? 'user' : 'ROLE_USER', parts: [{ text: 'work' }] },
      configuration: binding === '0.3' ? { blocking: false } : { returnImmediately: true },
    };
    const rpc = async (method: string, args: unknown) => {
      const response = await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 2, method, params: args }) });
      return (await response.json() as JSONRPCSuccessResponse).result as Task;
    };
    const lookup = async (id: string) => binding === 'http-json'
      ? await (await fetch(`${base}/tasks/${id}`)).json() as Task
      : rpc(binding === '0.3' ? 'tasks/get' : 'GetTask', { id });
    try {
      const response = await fetch(binding === 'http-json' ? `${base}/message:send` : base, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Connection: 'close' },
        body: JSON.stringify(binding === 'http-json' ? params : {
          jsonrpc: '2.0', id: 1, method: binding === '0.3' ? 'message/send' : 'SendMessage', params,
        }), signal: AbortSignal.any([controller.signal, AbortSignal.timeout(2000)]),
      });
      const body = await response.json() as { task?: Task; result?: Task };
      expect(response.status, JSON.stringify(body)).toBe(200);
      const accepted = (body.task ?? body.result)!;
      expect(accepted.id).toBe(f.taskId());
      expect(accepted.contextId).toBeTruthy();
      expect((await f.store.getTask(accepted.id))?.status.state).toBe(TaskState.WORKING);
      controller.abort();
      expect((await lookup(accepted.id)).status.state).toBe(binding === '0.3' ? 'working' : 'TASK_STATE_WORKING');
      f.gate.release();
      await terminal(f.store, accepted.id);
      const result = await lookup(accepted.id);
      const part = result.artifacts![0].parts[0] as { raw?: string; file?: { bytes?: string } };
      expect(Buffer.from((part.raw ?? part.file?.bytes)!, 'base64').toString()).toBe('actual-file-bytes');
      expect(f.execute).toHaveBeenCalledTimes(1);
      expect(accepted.status.state).toBe(binding === '0.3' ? 'working' : 'TASK_STATE_WORKING');
    } finally {
      f.gate.release();
      http.closeAllConnections();
      await new Promise<void>((resolve) => http.close(() => resolve()));
    }
  });

  it.each([true, undefined])('preserves blocking behavior when blocking=%s', async (blocking) => {
    const f = fixture();
    let returned = false;
    const pending = f.send(blocking === undefined ? {} : { blocking }).then((result) => { returned = true; return result; });
    try {
      await f.started.promise;
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(returned).toBe(false);
    } finally { f.gate.release(); }
    expect(((await pending).result as Task).status.state).toBe(TaskState.COMPLETED);
  });

  it('persists executor failures for later lookup', async () => {
    const f = fixture();
    f.execute.mockImplementation(async () => { await f.gate.promise; throw new Error('synthetic backend failure'); });
    const accepted = (await f.send()).result as Task;
    f.gate.release();
    const failed = await terminal(f.store, accepted.id, TaskState.FAILED);
    expect(failed.status.message?.parts).toEqual([{ text: 'synthetic backend failure' }]);
  });

  it('keeps explicit cancellation authoritative over a late completion', async () => {
    const f = fixture();
    const accepted = (await f.send()).result as Task;
    const canceled = await f.handler.handle({ jsonrpc: '2.0', id: 2, method: 'tasks/cancel', params: { id: accepted.id } }) as JSONRPCSuccessResponse;
    expect((canceled.result as Task).status.state).toBe(TaskState.CANCELED);
    f.gate.release();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect((await f.store.getTask(accepted.id))?.status.state).toBe(TaskState.CANCELED);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('rejects acceptance when the working state cannot be persisted', async () => {
    const f = fixture();
    vi.spyOn(f.store, 'updateTask').mockRejectedValue(new Error('store unavailable'));
    const response = await f.send();
    expect(response).toHaveProperty('error');
    expect(f.execute).not.toHaveBeenCalled();
  });

  it('keeps interaction-ending states queryable and allows a continuation', async () => {
    const f = fixture();
    f.execute.mockImplementationOnce(async (task) => { await f.gate.promise; return { ...task, status: { state: TaskState.INPUT_REQUIRED } }; });
    const accepted = (await f.send()).result as Task;
    f.gate.release();
    await terminal(f.store, accepted.id, TaskState.INPUT_REQUIRED);
    const continued = (await f.send({ blocking: false }, { taskId: accepted.id })).result as Task;
    expect(continued.id).toBe(accepted.id);
    await terminal(f.store, accepted.id);
    expect(f.execute).toHaveBeenCalledTimes(2);
  });

  it('preserves v1 explicit blocking and its default', async () => {
    for (const configuration of [{ returnImmediately: false, blocking: false }, {}]) {
      const f = fixture('1.0');
      let returned = false;
      const pending = f.send(configuration).then((result) => { returned = true; return result; });
      try {
        await f.started.promise;
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(returned).toBe(false);
      } finally { f.gate.release(); }
      expect(((await pending).result as Task).status.state).toBe('TASK_STATE_COMPLETED');
    }
  });

  it('retries a transient final write without dispatching again or losing artifacts', async () => {
    const f = fixture();
    const update = f.store.updateTask.bind(f.store);
    let failed = false;
    vi.spyOn(f.store, 'updateTask').mockImplementation(async (id, value) => {
      if (!failed && value.status?.state === TaskState.COMPLETED) {
        failed = true;
        throw new Error('transient final write failure');
      }
      return update(id, value);
    });
    const accepted = (await f.send()).result as Task;
    f.gate.release();
    const completed = await terminal(f.store, accepted.id);
    expect(completed.artifacts?.[0].artifactId).toBe('file');
    expect(f.execute).toHaveBeenCalledTimes(1);
  });

  it('reports unrecoverable background store failures without rejecting in the background', async () => {
    const f = fixture();
    const accepted = (await f.send()).result as Task;
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(f.store, 'updateTask').mockRejectedValue(new Error('store offline'));
    try {
      f.gate.release();
      await vi.waitFor(() => expect(log).toHaveBeenCalledWith(
        `Detached task '${accepted.id}' could not record its outcome`, expect.any(Error),
      ));
    } finally { log.mockRestore(); }
  });

  it('does not let executor mutation alter the acknowledgement snapshot', async () => {
    const f = fixture();
    f.execute.mockImplementation(async (task) => {
      task.status.state = TaskState.COMPLETED;
      await f.gate.promise;
      return task;
    });
    try {
      const accepted = (await f.send()).result as Task;
      expect(accepted.status.state).toBe(TaskState.WORKING);
    } finally { f.gate.release(); }
  });

  it('preserves authentication before accepting work and on later lookups', async () => {
    const f = fixture();
    f.server.addSecurityScheme('apiKey', new ApiKeyAuthorization({
      in: 'header', name: 'x-api-key', keys: ['secret'],
    })).addSecurityRequirement({ apiKey: [] });
    const request = { jsonrpc: '2.0' as const, id: 1, method: 'message/send', params: {
      message: { messageId: 'authorized', role: 'user', parts: [{ text: 'work' }] },
      configuration: { blocking: false },
    } };
    const denied = await f.handler.handle(request, { headers: {} }) as JSONRPCSuccessResponse;
    expect((denied.result as Task).status.state).toBe(TaskState.AUTH_REQUIRED);
    expect(f.execute).not.toHaveBeenCalled();
    const accepted = await f.context.run('caller-scope', () => f.handler.handle(request, {
      headers: { 'x-api-key': 'secret' },
    })) as JSONRPCSuccessResponse;
    const id = (accepted.result as Task).id;
    try {
      const get = { jsonrpc: '2.0' as const, id: 2, method: 'tasks/get', params: { id } };
      expect(await f.handler.handle(get, { headers: {} })).toHaveProperty('error');
      expect(await f.handler.handle(get, { headers: { 'x-api-key': 'secret' } })).toHaveProperty('result.id', id);
    } finally { f.gate.release(); }
    await terminal(f.store, id);
  });

  it.each([false, true])('delivers terminal push notifications after detached work (failure=%s)', async (fail) => {
    const f = fixture();
    if (fail) f.execute.mockImplementation(async () => { await f.gate.promise; throw new Error('failed'); });
    const accepted = (await f.send({ blocking: false, pushNotificationConfig: { id: 'hook', url: 'https://example.com/events' } })).result as Task;
    expect(f.push).not.toHaveBeenCalled();
    f.gate.release();
    await terminal(f.store, accepted.id, fail ? TaskState.FAILED : TaskState.COMPLETED);
    await vi.waitFor(() => expect(f.push).toHaveBeenCalledTimes(1));
  });

  it('allows another handler to subscribe to the detached task without another execution', async () => {
    const f = fixture();
    const accepted = (await f.send()).result as Task;
    const subscriber = new DefaultRequestHandler(f.server);
    const events = await subscriber.handle({ jsonrpc: '2.0', id: 2,
      method: 'tasks/resubscribe', params: { id: accepted.id } }) as AsyncGenerator<JSONRPCSuccessResponse>;
    const next = events.next();
    f.gate.release();
    expect((await next).value).toHaveProperty('result.status.state', TaskState.COMPLETED);
    await events.return(undefined);
    expect(f.execute).toHaveBeenCalledTimes(1);
  });
});
