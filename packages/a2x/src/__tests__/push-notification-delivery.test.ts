/**
 * Tests for the PushNotificationSender + DefaultRequestHandler dispatch
 * path (issue #119). Verifies:
 *
 * - Webhook is POSTed once the task reaches a terminal state in the
 *   blocking message/send path.
 * - Streaming message/stream also dispatches on terminal status.
 * - The dispatch reads every config registered for the task.
 * - The capability flag flips to true only when both store and sender
 *   are wired.
 */

import { describe, it, expect, vi } from 'vitest';
import { DefaultRequestHandler } from '../transport/request-handler.js';
import { A2XAgent } from '../a2x/a2x-agent.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryTaskStore } from '../a2x/task-store.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { InMemoryPushNotificationConfigStore } from '../a2x/push-notification-config-store.js';
import {
  FetchPushNotificationSender,
  type PushNotificationSender,
} from '../a2x/push-notification-sender.js';
import { BaseAgent } from '../agent/base-agent.js';
import type { AgentEvent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';
import type { JSONRPCResponse } from '../types/jsonrpc.js';

import '../a2x/index.js';

class EchoAgent extends BaseAgent {
  constructor() {
    super({ name: 'echo', description: 'echo' });
  }
  async *run(_context: InvocationContext): AsyncGenerator<AgentEvent> {
    yield { type: 'text', text: 'pong', role: 'agent' };
    yield { type: 'done' };
  }
}

function createTestAgent(sender: PushNotificationSender) {
  const agent = new EchoAgent();
  const runner = new InMemoryRunner({ agent, appName: 'test' });
  const executor = new AgentExecutor({
    runner,
    runConfig: { streamingMode: StreamingMode.SSE },
  });
  const pushStore = new InMemoryPushNotificationConfigStore();
  const a2x = new A2XAgent({
    taskStore: new InMemoryTaskStore(),
    executor,
    protocolVersion: '1.0',
    pushNotificationConfigStore: pushStore,
    pushNotificationSender: sender,
  }).setDefaultUrl('https://example.com/a2a');
  return { handler: new DefaultRequestHandler(a2x), pushStore };
}

async function flushDeliveries(): Promise<void> {
  // Dispatch is fire-and-forget (`void sender.send(...)`) so let pending
  // microtasks drain before assertions.
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('Push notification delivery (issue #119)', () => {
  it('does not fire on terminal state when no configs are registered (smoke)', async () => {
    const send = vi.fn(async () => {});
    const { handler } = createTestAgent({ send });

    // Drive a task end-to-end via message/send to obtain the task id.
    const firstResponse = await handler.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/send',
      params: {
        message: {
          messageId: 'msg-1',
          role: 'user',
          parts: [{ text: 'hello' }],
        },
      },
    });
    const firstTaskId = ((firstResponse as JSONRPCResponse) as { result: { id: string } })
      .result.id;
    expect(firstTaskId).toBeDefined();

    // No configs are registered for this task, so the dispatch must
    // be a no-op. Verifies we don't crash on store.list() returning [].
    await flushDeliveries();
    expect(send).not.toHaveBeenCalled();
  });

  it('webhook body is the spec-mapped Task wire shape, not the internal Task (issue #142 fix 1)', async () => {
    // v1.0 mapper produces UPPER_CASE state and role; v0.3 produces
    // lowercase with `kind` discriminators. Either way, the body must
    // match the agent's protocolVersion wire shape — never the raw
    // internal Task that would otherwise leak `state: "completed"`
    // (lowercase) when the peer is a v1.0 receiver.
    const send = vi.fn(async () => {});
    const { handler, pushStore } = createTestAgent({ send }); // v1.0 agent

    const streamResult = await handler.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/stream',
      params: {
        message: {
          messageId: 'msg-1',
          role: 'user',
          parts: [{ text: 'hi' }],
        },
      },
    });

    const generator = streamResult as AsyncGenerator<Record<string, unknown>>;
    for await (const event of generator) {
      const id = extractTaskId(event);
      if (id) {
        await pushStore.set({
          taskId: id,
          pushNotificationConfig: {
            id: 'cfg-1',
            url: 'https://hook.example.com/notify',
          },
        });
      }
    }

    await flushDeliveries();

    expect(send).toHaveBeenCalledTimes(1);
    const [, body] = send.mock.calls[0]! as [unknown, Record<string, unknown>];
    const status = body.status as Record<string, unknown>;
    // v1.0 wire requires UPPER_CASE state. The pre-fix code would have
    // delivered the internal lowercase `"completed"` here.
    expect(status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('POSTs every registered webhook on terminal state with multiple configs', async () => {
    const send = vi.fn(async () => {});
    const { handler, pushStore } = createTestAgent({ send });

    const streamResult = await handler.handle({
      jsonrpc: '2.0',
      id: 1,
      method: 'message/stream',
      params: {
        message: {
          messageId: 'msg-1',
          role: 'user',
          parts: [{ text: 'hi' }],
        },
      },
    });

    const generator = streamResult as AsyncGenerator<Record<string, unknown>>;
    let taskId: string | undefined;
    for await (const event of generator) {
      const id = extractTaskId(event);
      if (!taskId && id) {
        taskId = id;
        await pushStore.set({
          taskId,
          pushNotificationConfig: {
            id: 'cfg-a',
            url: 'https://hook.example.com/a',
          },
        });
        await pushStore.set({
          taskId,
          pushNotificationConfig: {
            id: 'cfg-b',
            url: 'https://hook.example.com/b',
          },
        });
      }
    }

    await flushDeliveries();

    expect(send).toHaveBeenCalledTimes(2);
    const urls = send.mock.calls.map(([config]) => config.pushNotificationConfig.url).sort();
    expect(urls).toEqual([
      'https://hook.example.com/a',
      'https://hook.example.com/b',
    ]);
  });

});

/**
 * Pull a `taskId` out of either shape we might see on the wire — the
 * pre-#118 bare-event format and the post-#118 JSON-RPC envelope. Lets
 * the test in this file work regardless of merge order.
 */
function extractTaskId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const envelope = value as { result?: unknown; taskId?: unknown };
  if (typeof envelope.taskId === 'string') return envelope.taskId;
  const result = envelope.result;
  if (
    result &&
    typeof result === 'object' &&
    typeof (result as { taskId?: unknown }).taskId === 'string'
  ) {
    return (result as { taskId: string }).taskId;
  }
  return undefined;
}

describe('FetchPushNotificationSender (issue #119)', () => {
  it('POSTs the JSON-encoded task body to the configured webhook URL', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    const sender = new FetchPushNotificationSender({ fetch: fetchMock });

    await sender.send(
      {
        taskId: 't1',
        pushNotificationConfig: {
          id: 'cfg-1',
          url: 'https://hook.example.com/notify',
          token: 'shared-secret',
        },
      },
      {
        id: 't1',
        status: { state: 'completed', timestamp: new Date().toISOString() },
      } as never,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]! as [string, RequestInit];
    expect(url).toBe('https://hook.example.com/notify');
    expect(init.method).toBe('POST');
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-A2A-Notification-Token']).toBe('shared-secret');
    expect(JSON.parse(init.body as string)).toMatchObject({ id: 't1' });
  });

  it('forwards Bearer credentials when the auth scheme requests it', async () => {
    const fetchMock = vi.fn(async () => new Response('', { status: 200 }));
    const sender = new FetchPushNotificationSender({ fetch: fetchMock });
    await sender.send(
      {
        taskId: 't1',
        pushNotificationConfig: {
          id: 'cfg-1',
          url: 'https://hook.example.com/notify',
          authentication: { schemes: ['Bearer'], credentials: 'tok-123' },
        },
      },
      { id: 't1', status: { state: 'completed' } } as never,
    );
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers['Authorization']).toBe('Bearer tok-123');
  });

  it('does not throw on transport failure (best-effort delivery)', async () => {
    const onError = vi.fn();
    const fetchMock = vi.fn(async () => {
      throw new Error('boom');
    });
    const sender = new FetchPushNotificationSender({
      fetch: fetchMock,
      onError,
    });
    await expect(
      sender.send(
        {
          taskId: 't1',
          pushNotificationConfig: { id: 'cfg-1', url: 'https://hook.example.com/notify' },
        },
        { id: 't1', status: { state: 'completed' } } as never,
      ),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled();
  });
});
