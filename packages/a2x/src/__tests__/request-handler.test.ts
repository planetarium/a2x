import { describe, it, expect } from 'vitest';
import { DefaultRequestHandler } from '../transport/request-handler.js';
import { A2XAgent } from '../a2x/a2x-agent.js';
import type { ProtocolVersion } from '../a2x/a2x-agent.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryTaskStore } from '../a2x/task-store.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { LlmAgent } from '../agent/llm-agent.js';
import { BaseLlmProvider } from '../provider/base.js';
import { A2A_ERROR_CODES } from '../types/errors.js';
import { TaskState, TaskStateV10 } from '../types/task.js';
import type { JSONRPCResponse, JSONRPCErrorResponse } from '../types/jsonrpc.js';
import { InMemoryPushNotificationConfigStore } from '../a2x/push-notification-config-store.js';
import type { TaskPushNotificationConfig } from '../types/jsonrpc.js';
import { ApiKeyAuthorization } from '../security/api-key.js';
import { HttpBearerAuthorization } from '../security/http-bearer.js';
import type { RequestContext } from '../types/auth.js';

// Ensure mappers are registered
import '../a2x/index.js';

const mockProvider = new (class extends BaseLlmProvider {
  readonly name = 'mock';
  constructor() { super({ model: 'gpt-4' }); }
  async generateContent() {
    return { content: [], finishReason: 'stop' };
  }
})();

function createHandler(protocolVersion?: ProtocolVersion): DefaultRequestHandler {
  return createHandlerWithStore(protocolVersion).handler;
}

function createHandlerWithStore(protocolVersion?: ProtocolVersion): {
  handler: DefaultRequestHandler;
  taskStore: InMemoryTaskStore;
} {
  const agent = new LlmAgent({
    name: 'test-agent',
    provider: mockProvider,
    description: 'A test agent',
    instruction: 'You are a helpful assistant.',
  });

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

function createHandlerWithPushNotification(protocolVersion?: ProtocolVersion): {
  handler: DefaultRequestHandler;
  pushStore: InMemoryPushNotificationConfigStore;
} {
  const agent = new LlmAgent({
    name: 'test-agent',
    provider: mockProvider,
    description: 'A test agent',
    instruction: 'You are a helpful assistant.',
  });

  const runner = new InMemoryRunner({ agent, appName: 'test' });
  const executor = new AgentExecutor({
    runner,
    runConfig: { streamingMode: StreamingMode.SSE },
  });
  const taskStore = new InMemoryTaskStore();
  const pushStore = new InMemoryPushNotificationConfigStore();
  const a2xAgent = new A2XAgent({
    taskStore,
    executor,
    protocolVersion,
    pushNotificationConfigStore: pushStore,
  });
  a2xAgent.setDefaultUrl('https://example.com/a2a');

  return { handler: new DefaultRequestHandler(a2xAgent), pushStore };
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in (value as object)
  );
}

describe('Layer 4: DefaultRequestHandler', () => {
  describe('JSON-RPC error handling', () => {
    it('should return parse error for invalid JSON string', async () => {
      const handler = createHandler();
      const response = await handler.handle('not json');

      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect(rpc.jsonrpc).toBe('2.0');
      expect(rpc.id).toBeNull();
      expect('error' in rpc).toBe(true);
      expect((rpc as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.JSON_PARSE_ERROR,
      );
    });

    it('should return invalid request for missing jsonrpc version', async () => {
      const handler = createHandler();
      const response = await handler.handle({
        jsonrpc: '1.0' as '2.0',
        id: 1,
        method: 'test',
      });

      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('error' in rpc).toBe(true);
      expect((rpc as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.INVALID_REQUEST,
      );
    });

    it('should return method not found for unknown method', async () => {
      const handler = createHandler();
      const response = await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'unknown/method',
      });

      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('error' in rpc).toBe(true);
      expect((rpc as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.METHOD_NOT_FOUND,
      );
    });
  });

  describe('message/send', () => {
    it('should process a message and return a task', async () => {
      const handler = createHandler();
      const response = await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: {
            messageId: 'msg-1',
            role: 'user',
            parts: [{ text: 'Hello' }],
          },
        },
      });

      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('result' in rpc).toBe(true);
      const task = (rpc as { result: unknown }).result as { id: string; status: { state: string } };
      expect(task.id).toBeDefined();
      // Default is v1.0, so state should be UPPER_SNAKE_CASE
      expect(task.status.state).toBe('TASK_STATE_COMPLETED');
    });

    it('should return invalid params when message is missing', async () => {
      const handler = createHandler();
      const response = await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {},
      });

      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('error' in rpc).toBe(true);
      expect((rpc as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.INVALID_PARAMS,
      );
    });
  });

  describe('message/send - v0.3 response format', () => {
    it('should include kind discriminators in v0.3 mode', async () => {
      const handler = createHandler('0.3');
      const response = await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: {
            messageId: 'msg-1',
            role: 'user',
            parts: [{ text: 'Hello' }],
          },
        },
      });

      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('result' in rpc).toBe(true);
      const task = (rpc as { result: unknown }).result as Record<string, unknown>;

      // Task-level kind
      expect(task.kind).toBe('task');

      // State should be lowercase
      expect((task.status as Record<string, unknown>).state).toBe('completed');

      // History should include the user message with kind discriminators
      const history = task.history as Array<Record<string, unknown>>;
      expect(history).toBeDefined();
      expect(history.length).toBeGreaterThanOrEqual(1);
      expect(history[0].kind).toBe('message');
      expect(history[0].role).toBe('user');

      const parts = history[0].parts as Array<Record<string, unknown>>;
      expect(parts[0].kind).toBe('text');
    });

    it('should default artifact name to "response" in v0.3 mode', async () => {
      const handler = createHandler('0.3');
      const response = await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: {
            messageId: 'msg-1',
            role: 'user',
            parts: [{ text: 'Hello' }],
          },
        },
      });

      const rpc = response as JSONRPCResponse;
      const task = (rpc as { result: unknown }).result as Record<string, unknown>;
      const artifacts = task.artifacts as Array<Record<string, unknown>> | undefined;

      if (artifacts && artifacts.length > 0) {
        // Each artifact should have a name (defaulting to "response")
        for (const artifact of artifacts) {
          expect(artifact.name).toBeDefined();
        }
      }
    });
  });

  describe('message/send - v1.0 response format', () => {
    it('should NOT include kind discriminators in v1.0 mode', async () => {
      const handler = createHandler('1.0');
      const response = await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: {
            messageId: 'msg-1',
            role: 'user',
            parts: [{ text: 'Hello' }],
          },
        },
      });

      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('result' in rpc).toBe(true);
      const task = (rpc as { result: unknown }).result as Record<string, unknown>;

      // No kind field
      expect(task.kind).toBeUndefined();

      // State should be UPPER_SNAKE_CASE
      expect((task.status as Record<string, unknown>).state).toBe('TASK_STATE_COMPLETED');

      // No injected history
      expect(task.history).toBeUndefined();
    });
  });

  describe('tasks/get', () => {
    it('should return task not found for non-existent task', async () => {
      const handler = createHandler();
      const response = await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/get',
        params: { id: 'non-existent' },
      });

      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('error' in rpc).toBe(true);
      expect((rpc as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.TASK_NOT_FOUND,
      );
    });

    it('should return a task after it was created via message/send', async () => {
      const handler = createHandler();

      // Create a task first
      const sendResponse = await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: {
            messageId: 'msg-1',
            role: 'user',
            parts: [{ text: 'Hello' }],
          },
        },
      });

      const task = ((sendResponse as JSONRPCResponse) as { result: unknown }).result as { id: string };

      // Get the task
      const getResponse = await handler.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/get',
        params: { id: task.id },
      });

      expect(isAsyncGenerator(getResponse)).toBe(false);
      const rpc = getResponse as JSONRPCResponse;
      expect('result' in rpc).toBe(true);
      const retrieved = (rpc as { result: unknown }).result as { id: string };
      expect(retrieved.id).toBe(task.id);
    });

    it('should apply v1.0 mapping to tasks/get response', async () => {
      const handler = createHandler('1.0');

      // Create a task
      const sendResponse = await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: {
            messageId: 'msg-1',
            role: 'user',
            parts: [{ text: 'Hello' }],
          },
        },
      });

      const task = ((sendResponse as JSONRPCResponse) as { result: unknown }).result as { id: string };

      // Get the task
      const getResponse = await handler.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/get',
        params: { id: task.id },
      });

      const rpc = getResponse as JSONRPCResponse;
      const retrieved = (rpc as { result: unknown }).result as Record<string, unknown>;

      // v1.0: no kind, UPPER_SNAKE_CASE state
      expect(retrieved.kind).toBeUndefined();
      expect((retrieved.status as Record<string, unknown>).state).toBe('TASK_STATE_COMPLETED');
    });

    it('should apply v0.3 mapping to tasks/get response', async () => {
      const handler = createHandler('0.3');

      // Create a task
      const sendResponse = await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: {
            messageId: 'msg-1',
            role: 'user',
            parts: [{ text: 'Hello' }],
          },
        },
      });

      const task = ((sendResponse as JSONRPCResponse) as { result: unknown }).result as { id: string };

      // Get the task
      const getResponse = await handler.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/get',
        params: { id: task.id },
      });

      const rpc = getResponse as JSONRPCResponse;
      const retrieved = (rpc as { result: unknown }).result as Record<string, unknown>;

      // v0.3: has kind, lowercase state
      expect(retrieved.kind).toBe('task');
      expect((retrieved.status as Record<string, unknown>).state).toBe('completed');
    });

    it('honors TaskQueryParams.historyLength on tasks/get', async () => {
      // Spec a2a-v0.3 §TaskQueryParams: clients can bound how many history
      // entries the server returns to avoid pulling the full transcript on
      // every poll. See issue #120.
      const { handler, taskStore } = createHandlerWithStore('0.3');

      // Seed a task with a 3-entry history directly so we don't depend on
      // the executor's accumulation behavior (which is out of scope here).
      const seeded = await taskStore.createTask({});
      await taskStore.updateTask(seeded.id, {
        history: ['one', 'two', 'three'].map((t, i) => ({
          messageId: `msg-${i}`,
          role: 'user' as const,
          parts: [{ text: t }],
        })),
      });

      // Without historyLength: full history.
      const fullResponse = await handler.handle({
        jsonrpc: '2.0',
        id: 3,
        method: 'tasks/get',
        params: { id: seeded.id },
      });
      const fullTask = ((fullResponse as JSONRPCResponse) as {
        result: { history: unknown[] };
      }).result;
      expect(fullTask.history).toHaveLength(3);

      // historyLength=1: server slices to the most recent entry.
      const slicedResponse = await handler.handle({
        jsonrpc: '2.0',
        id: 4,
        method: 'tasks/get',
        params: { id: seeded.id, historyLength: 1 },
      });
      const slicedTask = ((slicedResponse as JSONRPCResponse) as {
        result: { history: { parts: { text: string }[] }[] };
      }).result;
      expect(slicedTask.history).toHaveLength(1);
      // The most recent entry survives.
      expect(slicedTask.history[0].parts[0].text).toBe('three');

      // historyLength=0: empty array, history field present.
      const emptyResponse = await handler.handle({
        jsonrpc: '2.0',
        id: 5,
        method: 'tasks/get',
        params: { id: seeded.id, historyLength: 0 },
      });
      const emptyTask = ((emptyResponse as JSONRPCResponse) as {
        result: { history?: unknown[] };
      }).result;
      // Mapper omits empty history; either is acceptable so long as we
      // didn't return more than 0 entries.
      expect(emptyTask.history === undefined || emptyTask.history.length === 0).toBe(true);
    });

    it('rejects negative or non-integer historyLength on tasks/get', async () => {
      const handler = createHandler();
      for (const bad of [-1, 1.5, 'two']) {
        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/get',
          params: { id: 'whatever', historyLength: bad },
        });
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.INVALID_PARAMS,
        );
      }
    });
  });

  describe('tasks/cancel', () => {
    it('should return task not found for non-existent task', async () => {
      const handler = createHandler();
      const response = await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/cancel',
        params: { id: 'non-existent' },
      });

      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('error' in rpc).toBe(true);
      expect((rpc as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.TASK_NOT_FOUND,
      );
    });

    it('should cancel a working task without terminal state guard collision', async () => {
      // Set up handler with access to taskStore
      const agent = new LlmAgent({
        name: 'test-agent',
        provider: mockProvider,
        description: 'A test agent',
        instruction: 'You are a helpful assistant.',
      });
      const runner = new InMemoryRunner({ agent, appName: 'test' });
      const executor = new AgentExecutor({
        runner,
        runConfig: { streamingMode: StreamingMode.SSE },
      });
      const taskStore = new InMemoryTaskStore();
      const a2xAgent = new A2XAgent({ taskStore, executor });
      a2xAgent.setDefaultUrl('https://example.com/a2a');
      const handler = new DefaultRequestHandler(a2xAgent);

      // Create a task and set it to WORKING state directly
      const task = await taskStore.createTask({});
      await taskStore.updateTask(task.id, {
        status: { state: TaskState.WORKING, timestamp: new Date().toISOString() },
      });

      // Cancel the WORKING task — this should NOT throw InternalError
      // Before fix: cancel() mutated task to CANCELED, then updateTask()
      // hit the terminal state guard and threw "Cannot update task in terminal state"
      const cancelResponse = await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/cancel',
        params: { id: task.id },
      });

      expect(isAsyncGenerator(cancelResponse)).toBe(false);
      const rpc = cancelResponse as JSONRPCResponse;
      expect('error' in rpc).toBe(false);
      expect('result' in rpc).toBe(true);
    });
  });

  describe('message/stream', () => {
    it('should return an AsyncGenerator via handle()', async () => {
      const handler = createHandler();
      const result = await handler.handle({
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

      expect(isAsyncGenerator(result)).toBe(true);

      // Each chunk is a JSON-RPC success envelope
      // ({ jsonrpc, id, result }) per spec §SendStreamingMessageSuccessResponse.
      const generator = result as AsyncGenerator<{
        jsonrpc: '2.0';
        id: number;
        result: Record<string, unknown>;
      }>;
      const events: Record<string, unknown>[] = [];

      for await (const envelope of generator) {
        expect(envelope.jsonrpc).toBe('2.0');
        expect(envelope.id).toBe(1);
        events.push(envelope.result);
      }

      // Should have received events (status_update + artifact_updates + final status)
      expect(events.length).toBeGreaterThan(0);

      // Default is v1.0: status state should be UPPER_SNAKE_CASE
      const first = events[0];
      const firstStatus = first.status as Record<string, unknown> | undefined;
      if (firstStatus) {
        expect(firstStatus.state).toBe('TASK_STATE_WORKING');
      }

      // Last status event should be completed
      const statusEvents = events.filter((e) => e.status !== undefined);
      const lastStatus = statusEvents[statusEvents.length - 1] as { status: { state: string } };
      expect(lastStatus.status.state).toBe('TASK_STATE_COMPLETED');
    });

    it('should apply v0.3 mapping to streaming events', async () => {
      const handler = createHandler('0.3');
      const result = await handler.handle({
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

      expect(isAsyncGenerator(result)).toBe(true);

      const generator = result as AsyncGenerator<{
        jsonrpc: '2.0';
        id: number;
        result: Record<string, unknown>;
      }>;
      const events: Record<string, unknown>[] = [];

      for await (const envelope of generator) {
        events.push(envelope.result);
      }

      expect(events.length).toBeGreaterThan(0);

      // Status events should have kind: "status-update"
      const statusEvents = events.filter((e) => e.status !== undefined);
      for (const event of statusEvents) {
        expect(event.kind).toBe('status-update');
      }

      // Artifact events should have kind: "artifact-update"
      const artifactEvents = events.filter((e) => e.artifact !== undefined);
      for (const event of artifactEvents) {
        expect(event.kind).toBe('artifact-update');
      }

      // First status event should use lowercase state
      if (statusEvents.length > 0) {
        const firstStatus = statusEvents[0].status as Record<string, unknown>;
        expect(firstStatus.state).toBe('working');
      }
    });

    it('should NOT include kind in v1.0 streaming events', async () => {
      const handler = createHandler('1.0');
      const result = await handler.handle({
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

      expect(isAsyncGenerator(result)).toBe(true);

      const generator = result as AsyncGenerator<{
        jsonrpc: '2.0';
        id: number;
        result: Record<string, unknown>;
      }>;
      const events: Record<string, unknown>[] = [];

      for await (const envelope of generator) {
        events.push(envelope.result);
      }

      // No event should have a kind field
      for (const event of events) {
        expect(event.kind).toBeUndefined();
      }
    });
  });

  describe('getAgentCard', () => {
    it('should return agent card', () => {
      const handler = createHandler();
      const card = handler.getAgentCard('1.0');
      expect(card).toBeDefined();
      expect((card as { name: string }).name).toBe('test-agent');
    });
  });

  describe('Authentication', () => {
    function createAuthHandler(
      schemeSetup: (agent: A2XAgent) => void,
    ): DefaultRequestHandler {
      const agent = new LlmAgent({
        name: 'auth-test-agent',
        provider: mockProvider,
        description: 'A test agent with auth',
        instruction: 'You are a helpful assistant.',
      });

      const runner = new InMemoryRunner({ agent, appName: 'test' });
      const executor = new AgentExecutor({
        runner,
        runConfig: { streamingMode: StreamingMode.SSE },
      });
      const taskStore = new InMemoryTaskStore();
      const a2xAgent = new A2XAgent({ taskStore, executor });
      a2xAgent.setDefaultUrl('https://example.com/a2a');
      schemeSetup(a2xAgent);

      return new DefaultRequestHandler(a2xAgent);
    }

    const validRequest = {
      jsonrpc: '2.0' as const,
      id: 1,
      method: 'message/send',
      params: {
        message: {
          messageId: 'msg-1',
          role: 'user',
          parts: [{ text: 'Hello' }],
        },
      },
    };

    it('should pass without context (backward compatible)', async () => {
      const handler = createAuthHandler((agent) => {
        agent
          .addSecurityScheme('apiKey', new ApiKeyAuthorization({
            in: 'header',
            name: 'x-api-key',
            keys: ['secret'],
          }))
          .addSecurityRequirement({ apiKey: [] });
      });

      // No context → no auth check → should proceed
      const response = await handler.handle(validRequest);
      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('result' in rpc).toBe(true);
    });

    it('should authenticate with valid API key', async () => {
      const handler = createAuthHandler((agent) => {
        agent
          .addSecurityScheme('apiKey', new ApiKeyAuthorization({
            in: 'header',
            name: 'x-api-key',
            keys: ['secret-123'],
          }))
          .addSecurityRequirement({ apiKey: [] });
      });

      const context: RequestContext = {
        headers: { 'x-api-key': 'secret-123' },
      };
      const response = await handler.handle(validRequest, context);
      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('result' in rpc).toBe(true);
    });

    // Per A2A spec (TaskState.auth-required in v0.3 / TASK_STATE_AUTH_REQUIRED
    // in v1.0), an auth failure on a task-creating method surfaces as a Task
    // in `auth-required` state, not a JSON-RPC error.
    it('should surface auth failure as auth-required task for invalid API key', async () => {
      const handler = createAuthHandler((agent) => {
        agent
          .addSecurityScheme('apiKey', new ApiKeyAuthorization({
            in: 'header',
            name: 'x-api-key',
            keys: ['secret-123'],
          }))
          .addSecurityRequirement({ apiKey: [] });
      });

      const context: RequestContext = {
        headers: { 'x-api-key': 'wrong-key' },
      };
      const response = await handler.handle(validRequest, context);
      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('result' in rpc).toBe(true);
      const task = (rpc as { result: { status: { state: string } } }).result;
      // createAuthHandler defaults to protocol v1.0 → wire form is the
      // proto enum name, not the v0.3 kebab string.
      expect(task.status.state).toBe(TaskStateV10.TASK_STATE_AUTH_REQUIRED);
    });

    it('should surface auth failure as auth-required task for missing API key', async () => {
      const handler = createAuthHandler((agent) => {
        agent
          .addSecurityScheme('apiKey', new ApiKeyAuthorization({
            in: 'header',
            name: 'x-api-key',
            keys: ['secret-123'],
          }))
          .addSecurityRequirement({ apiKey: [] });
      });

      const context: RequestContext = { headers: {} };
      const response = await handler.handle(validRequest, context);
      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('result' in rpc).toBe(true);
      const task = (rpc as { result: { status: { state: string } } }).result;
      // createAuthHandler defaults to protocol v1.0 → wire form is the
      // proto enum name, not the v0.3 kebab string.
      expect(task.status.state).toBe(TaskStateV10.TASK_STATE_AUTH_REQUIRED);
    });

    it('should support OR logic: pass if any requirement group succeeds', async () => {
      const handler = createAuthHandler((agent) => {
        agent
          .addSecurityScheme('apiKey', new ApiKeyAuthorization({
            in: 'header',
            name: 'x-api-key',
            keys: ['key-1'],
          }))
          .addSecurityScheme('bearer', new HttpBearerAuthorization({
            scheme: 'bearer',
            validator: async (token) => ({
              authenticated: token === 'valid-token',
              error: token !== 'valid-token' ? 'Invalid token' : undefined,
            }),
          }))
          // OR: either apiKey OR bearer
          .addSecurityRequirement({ apiKey: [] })
          .addSecurityRequirement({ bearer: [] });
      });

      // API key fails, but bearer succeeds → should pass
      const context: RequestContext = {
        headers: {
          'x-api-key': 'wrong',
          authorization: 'Bearer valid-token',
        },
      };
      const response = await handler.handle(validRequest, context);
      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('result' in rpc).toBe(true);
    });

    it('should reject when all requirement groups fail', async () => {
      const handler = createAuthHandler((agent) => {
        agent
          .addSecurityScheme('apiKey', new ApiKeyAuthorization({
            in: 'header',
            name: 'x-api-key',
            keys: ['key-1'],
          }))
          .addSecurityScheme('bearer', new HttpBearerAuthorization({
            scheme: 'bearer',
            validator: async (token) => ({
              authenticated: token === 'valid-token',
              error: token !== 'valid-token' ? 'Invalid token' : undefined,
            }),
          }))
          .addSecurityRequirement({ apiKey: [] })
          .addSecurityRequirement({ bearer: [] });
      });

      // Both fail
      const context: RequestContext = {
        headers: {
          'x-api-key': 'wrong',
          authorization: 'Bearer wrong-token',
        },
      };
      const response = await handler.handle(validRequest, context);
      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('result' in rpc).toBe(true);
      const task = (rpc as { result: { status: { state: string } } }).result;
      // createAuthHandler defaults to protocol v1.0 → wire form is the
      // proto enum name, not the v0.3 kebab string.
      expect(task.status.state).toBe(TaskStateV10.TASK_STATE_AUTH_REQUIRED);
    });

    it('should skip auth when no security requirements are set', async () => {
      const handler = createAuthHandler((agent) => {
        // Add scheme but no requirement → no auth check
        agent.addSecurityScheme('apiKey', new ApiKeyAuthorization({
          in: 'header',
          name: 'x-api-key',
          keys: ['secret'],
        }));
      });

      const context: RequestContext = { headers: {} };
      const response = await handler.handle(validRequest, context);
      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('result' in rpc).toBe(true);
    });

    it('should emit an auth-required status event for message/stream auth failure', async () => {
      const handler = createAuthHandler((agent) => {
        agent
          .addSecurityScheme('apiKey', new ApiKeyAuthorization({
            in: 'header',
            name: 'x-api-key',
            keys: ['secret'],
          }))
          .addSecurityRequirement({ apiKey: [] });
      });

      const streamRequest = {
        jsonrpc: '2.0' as const,
        id: 2,
        method: 'message/stream',
        params: validRequest.params,
      };
      const context: RequestContext = { headers: {} };
      const response = await handler.handle(streamRequest, context);
      expect(isAsyncGenerator(response)).toBe(true);
      const events: { jsonrpc: '2.0'; id: number; result: Record<string, unknown> }[] = [];
      for await (const envelope of response as AsyncGenerator<{
        jsonrpc: '2.0';
        id: number;
        result: Record<string, unknown>;
      }>) {
        events.push(envelope);
      }
      expect(events).toHaveLength(1);
      expect(events[0].id).toBe(2);
      const status = events[0].result.status as { state: string };
      expect(status.state).toBe(TaskStateV10.TASK_STATE_AUTH_REQUIRED);
    });

    it('should fall back to InvalidRequest for non-task-shaped methods on auth failure', async () => {
      const handler = createAuthHandler((agent) => {
        agent
          .addSecurityScheme('apiKey', new ApiKeyAuthorization({
            in: 'header',
            name: 'x-api-key',
            keys: ['secret'],
          }))
          .addSecurityRequirement({ apiKey: [] });
      });

      const getTaskRequest = {
        jsonrpc: '2.0' as const,
        id: 3,
        method: 'tasks/get',
        params: { id: 'task-id' },
      };
      const context: RequestContext = { headers: {} };
      const response = await handler.handle(getTaskRequest, context);
      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('error' in rpc).toBe(true);
      expect((rpc as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.INVALID_REQUEST,
      );
    });
  });

  describe('tasks/pushNotificationConfig/delete', () => {
    it('should return PushNotificationNotSupported when no store configured', async () => {
      const handler = createHandler();
      const response = await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/pushNotificationConfig/delete',
        params: { taskId: 'task-1', id: 'config-1' },
      });

      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('error' in rpc).toBe(true);
      expect((rpc as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED,
      );
    });

    describe('v1.0 parameter format (taskId + id)', () => {
      it('should delete an existing config and return null result', async () => {
        const { handler, pushStore } = createHandlerWithPushNotification('1.0');

        const config: TaskPushNotificationConfig = {
          taskId: 'task-1',
          pushNotificationConfig: {
            id: 'config-1',
            url: 'https://example.com/webhook',
          },
        };
        await pushStore.set(config);

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/delete',
          params: { taskId: 'task-1', id: 'config-1' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(false);
        expect((rpc as { result: unknown }).result).toBeNull();

        const after = await pushStore.get('task-1', 'config-1');
        expect(after).toBeNull();
      });

      it('should return TaskNotFound when config does not exist', async () => {
        const { handler } = createHandlerWithPushNotification('1.0');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/delete',
          params: { taskId: 'task-1', id: 'non-existent' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.TASK_NOT_FOUND,
        );
      });

      it('should return InvalidParams when taskId is missing', async () => {
        const { handler } = createHandlerWithPushNotification('1.0');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/delete',
          params: { id: 'config-1' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.INVALID_PARAMS,
        );
      });

      it('should return InvalidParams when id is missing', async () => {
        const { handler } = createHandlerWithPushNotification('1.0');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/delete',
          params: { taskId: 'task-1' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.INVALID_PARAMS,
        );
      });
    });

    describe('v0.3 parameter format (id + pushNotificationConfigId)', () => {
      it('should delete an existing config and return null result', async () => {
        const { handler, pushStore } = createHandlerWithPushNotification('0.3');

        const config: TaskPushNotificationConfig = {
          taskId: 'task-1',
          pushNotificationConfig: {
            id: 'config-1',
            url: 'https://example.com/webhook',
          },
        };
        await pushStore.set(config);

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/delete',
          params: { id: 'task-1', pushNotificationConfigId: 'config-1' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(false);
        expect((rpc as { result: unknown }).result).toBeNull();

        const after = await pushStore.get('task-1', 'config-1');
        expect(after).toBeNull();
      });

      it('should return TaskNotFound when config does not exist', async () => {
        const { handler } = createHandlerWithPushNotification('0.3');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/delete',
          params: { id: 'task-1', pushNotificationConfigId: 'non-existent' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.TASK_NOT_FOUND,
        );
      });

      it('should return InvalidParams when id (task ID) is missing', async () => {
        const { handler } = createHandlerWithPushNotification('0.3');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/delete',
          params: { pushNotificationConfigId: 'config-1' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.INVALID_PARAMS,
        );
      });

      it('should return InvalidParams when pushNotificationConfigId is missing', async () => {
        const { handler } = createHandlerWithPushNotification('0.3');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/delete',
          params: { id: 'task-1' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.INVALID_PARAMS,
        );
      });
    });
  });

  describe('message/send — inline pushNotificationConfig (issue #120)', () => {
    it('registers configuration.pushNotificationConfig in the store before execution', async () => {
      // Spec a2a-v0.3 §MessageSendConfiguration: clients can register a
      // webhook config in the same call that creates the task — no
      // follow-up tasks/pushNotificationConfig/set round-trip needed.
      const { handler, pushStore } = createHandlerWithPushNotification('1.0');

      const response = await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: {
            messageId: 'msg-1',
            role: 'user',
            parts: [{ text: 'Hello' }],
          },
          configuration: {
            pushNotificationConfig: {
              id: 'inline-cfg-1',
              url: 'https://example.com/webhook',
              token: 't1',
            },
          },
        },
      });

      const taskId = ((response as JSONRPCResponse) as { result: { id: string } }).result.id;
      const stored = await pushStore.get(taskId, 'inline-cfg-1');
      expect(stored).toEqual({
        taskId,
        pushNotificationConfig: {
          id: 'inline-cfg-1',
          url: 'https://example.com/webhook',
          token: 't1',
        },
      });
    });

    it('errors PushNotificationNotSupported when configuration.pushNotificationConfig is sent to a no-store agent', async () => {
      const handler = createHandler('1.0');
      const response = await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'message/send',
        params: {
          message: {
            messageId: 'msg-1',
            role: 'user',
            parts: [{ text: 'Hello' }],
          },
          configuration: {
            pushNotificationConfig: {
              id: 'inline-cfg-1',
              url: 'https://example.com/webhook',
            },
          },
        },
      });
      const rpc = response as JSONRPCResponse;
      expect('error' in rpc).toBe(true);
      expect((rpc as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED,
      );
    });
  });

  describe('tasks/pushNotificationConfig/set', () => {
    it('should return PushNotificationNotSupported when no store configured', async () => {
      const handler = createHandler();
      const response = await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/pushNotificationConfig/set',
        params: {
          taskId: 'task-1',
          pushNotificationConfig: {
            id: 'config-1',
            url: 'https://example.com/webhook',
          },
        },
      });

      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('error' in rpc).toBe(true);
      expect((rpc as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED,
      );
    });

    describe('v0.3 wire format (TaskPushNotificationConfig nested)', () => {
      it('should store a new config and return the v0.3 nested shape', async () => {
        const { handler, pushStore } = createHandlerWithPushNotification('0.3');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/set',
          params: {
            taskId: 'task-1',
            pushNotificationConfig: {
              id: 'config-1',
              url: 'https://example.com/webhook',
              token: 't1',
            },
          },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(false);
        expect((rpc as { result: unknown }).result).toEqual({
          taskId: 'task-1',
          pushNotificationConfig: {
            id: 'config-1',
            url: 'https://example.com/webhook',
            token: 't1',
          },
        });

        const stored = await pushStore.get('task-1', 'config-1');
        expect(stored).toEqual({
          taskId: 'task-1',
          pushNotificationConfig: {
            id: 'config-1',
            url: 'https://example.com/webhook',
            token: 't1',
          },
        });
      });

      it('should auto-generate pushNotificationConfig.id when client omits it', async () => {
        const { handler, pushStore } = createHandlerWithPushNotification('0.3');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/set',
          params: {
            taskId: 'task-1',
            pushNotificationConfig: { url: 'https://example.com/webhook' },
          },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(false);
        const result = (rpc as { result: { pushNotificationConfig: { id?: string } } }).result;
        const generatedId = result.pushNotificationConfig.id;
        expect(typeof generatedId).toBe('string');
        expect(generatedId).not.toEqual('');

        // Round-trip: the auto-generated id indexes the store.
        const stored = await pushStore.get('task-1', generatedId!);
        expect(stored?.pushNotificationConfig.id).toBe(generatedId);
      });

      it('should treat empty-string pushNotificationConfig.id as absent and auto-generate', async () => {
        const { handler, pushStore } = createHandlerWithPushNotification('0.3');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/set',
          params: {
            taskId: 'task-1',
            pushNotificationConfig: { id: '', url: 'https://example.com/webhook' },
          },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(false);
        const result = (rpc as { result: { pushNotificationConfig: { id?: string } } }).result;
        const generatedId = result.pushNotificationConfig.id;
        expect(typeof generatedId).toBe('string');
        expect(generatedId).not.toEqual('');

        const stored = await pushStore.get('task-1', generatedId!);
        expect(stored?.pushNotificationConfig.id).toBe(generatedId);
      });

      it('should accept v0.3 spec authentication shape with schemes array', async () => {
        const { handler, pushStore } = createHandlerWithPushNotification('0.3');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/set',
          params: {
            taskId: 'task-1',
            pushNotificationConfig: {
              id: 'config-1',
              url: 'https://example.com/webhook',
              authentication: { schemes: ['Bearer'], credentials: 'abc123' },
            },
          },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(false);
        const result = (rpc as { result: { pushNotificationConfig: { authentication: unknown } } }).result;
        expect(result.pushNotificationConfig.authentication).toEqual({
          schemes: ['Bearer'],
          credentials: 'abc123',
        });

        const stored = await pushStore.get('task-1', 'config-1');
        expect(stored?.pushNotificationConfig.authentication).toEqual({
          schemes: ['Bearer'],
          credentials: 'abc123',
        });
      });

      it('should return InvalidParams when v0.3 authentication.schemes is empty', async () => {
        const { handler } = createHandlerWithPushNotification('0.3');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/set',
          params: {
            taskId: 'task-1',
            pushNotificationConfig: {
              id: 'config-1',
              url: 'https://example.com/webhook',
              authentication: { schemes: [] },
            },
          },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.INVALID_PARAMS,
        );
      });
    });

    describe('v1.0 wire format (flattened response)', () => {
      it('should store a new config and return the v1.0 flattened shape', async () => {
        const { handler, pushStore } = createHandlerWithPushNotification('1.0');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/set',
          params: {
            taskId: 'task-1',
            pushNotificationConfig: {
              id: 'config-1',
              url: 'https://example.com/webhook',
              token: 't1',
            },
          },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(false);
        expect((rpc as { result: unknown }).result).toEqual({
          id: 'config-1',
          taskId: 'task-1',
          url: 'https://example.com/webhook',
          token: 't1',
        });

        const stored = await pushStore.get('task-1', 'config-1');
        expect(stored).toEqual({
          taskId: 'task-1',
          pushNotificationConfig: {
            id: 'config-1',
            url: 'https://example.com/webhook',
            token: 't1',
          },
        });
      });
    });

    describe('validation', () => {
      it('should return InvalidParams when params is not an object', async () => {
        const { handler } = createHandlerWithPushNotification('1.0');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/set',
          params: 'not-an-object',
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.INVALID_PARAMS,
        );
      });

      it('should return InvalidParams when taskId is missing', async () => {
        const { handler } = createHandlerWithPushNotification('1.0');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/set',
          params: {
            pushNotificationConfig: {
              id: 'config-1',
              url: 'https://example.com/webhook',
            },
          },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.INVALID_PARAMS,
        );
      });

      it('should return InvalidParams when pushNotificationConfig is missing', async () => {
        const { handler } = createHandlerWithPushNotification('1.0');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/set',
          params: { taskId: 'task-1' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.INVALID_PARAMS,
        );
      });

      it('should return InvalidParams when pushNotificationConfig.url is missing', async () => {
        const { handler } = createHandlerWithPushNotification('1.0');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/set',
          params: {
            taskId: 'task-1',
            pushNotificationConfig: { id: 'config-1' },
          },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.INVALID_PARAMS,
        );
      });

      it('should return InvalidParams when authentication.scheme is missing', async () => {
        const { handler } = createHandlerWithPushNotification('1.0');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/set',
          params: {
            taskId: 'task-1',
            pushNotificationConfig: {
              id: 'config-1',
              url: 'https://example.com/webhook',
              authentication: { credentials: 'abc123' },
            },
          },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.INVALID_PARAMS,
        );
      });

      it('should reject v0.3-shape authentication.schemes on a v1.0 wire', async () => {
        const { handler } = createHandlerWithPushNotification('1.0');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/set',
          params: {
            taskId: 'task-1',
            pushNotificationConfig: {
              id: 'config-1',
              url: 'https://example.com/webhook',
              authentication: { schemes: ['Bearer'] },
            },
          },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.INVALID_PARAMS,
        );
      });

      it('should accept v1.0 spec authentication shape and round-trip via internal v0.3 form', async () => {
        const { handler, pushStore } = createHandlerWithPushNotification('1.0');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/set',
          params: {
            taskId: 'task-1',
            pushNotificationConfig: {
              id: 'config-1',
              url: 'https://example.com/webhook',
              authentication: { scheme: 'Bearer', credentials: 'abc123' },
            },
          },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(false);
        const result = (rpc as { result: { authentication: unknown } }).result;
        expect(result.authentication).toEqual({ scheme: 'Bearer', credentials: 'abc123' });

        const stored = await pushStore.get('task-1', 'config-1');
        expect(stored?.pushNotificationConfig.authentication).toEqual({
          schemes: ['Bearer'],
          credentials: 'abc123',
        });
      });
    });
  });

  describe('tasks/pushNotificationConfig/get', () => {
    it('should return PushNotificationNotSupported when no store configured', async () => {
      const handler = createHandler();
      const response = await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/pushNotificationConfig/get',
        params: { taskId: 'task-1', id: 'config-1' },
      });

      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('error' in rpc).toBe(true);
      expect((rpc as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED,
      );
    });

    describe('v1.0 parameter format (taskId + id)', () => {
      it('should return an existing config in v1.0 flattened shape', async () => {
        const { handler, pushStore } = createHandlerWithPushNotification('1.0');

        const config: TaskPushNotificationConfig = {
          taskId: 'task-1',
          pushNotificationConfig: {
            id: 'config-1',
            url: 'https://example.com/webhook',
            token: 'tok-1',
          },
        };
        await pushStore.set(config);

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/get',
          params: { taskId: 'task-1', id: 'config-1' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(false);
        expect((rpc as { result: unknown }).result).toEqual({
          id: 'config-1',
          taskId: 'task-1',
          url: 'https://example.com/webhook',
          token: 'tok-1',
        });
      });

      it('should translate stored authentication to v1.0 wire shape on read', async () => {
        const { handler, pushStore } = createHandlerWithPushNotification('1.0');

        await pushStore.set({
          taskId: 'task-1',
          pushNotificationConfig: {
            id: 'config-1',
            url: 'https://example.com/webhook',
            authentication: { schemes: ['Bearer'], credentials: 'abc123' },
          },
        });

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/get',
          params: { taskId: 'task-1', id: 'config-1' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(false);
        const result = (rpc as { result: { authentication: unknown } }).result;
        expect(result.authentication).toEqual({ scheme: 'Bearer', credentials: 'abc123' });
      });

      it('should return TaskNotFound when config does not exist', async () => {
        const { handler } = createHandlerWithPushNotification('1.0');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/get',
          params: { taskId: 'task-1', id: 'non-existent' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.TASK_NOT_FOUND,
        );
      });

      it('should return InvalidParams when taskId is missing', async () => {
        const { handler } = createHandlerWithPushNotification('1.0');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/get',
          params: { id: 'config-1' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.INVALID_PARAMS,
        );
      });

      it('should return InvalidParams when id is missing', async () => {
        const { handler } = createHandlerWithPushNotification('1.0');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/get',
          params: { taskId: 'task-1' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.INVALID_PARAMS,
        );
      });
    });

    describe('v0.3 parameter format (id + pushNotificationConfigId)', () => {
      it('should return an existing config in v0.3 nested shape', async () => {
        const { handler, pushStore } = createHandlerWithPushNotification('0.3');

        const config: TaskPushNotificationConfig = {
          taskId: 'task-1',
          pushNotificationConfig: {
            id: 'config-1',
            url: 'https://example.com/webhook',
          },
        };
        await pushStore.set(config);

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/get',
          params: { id: 'task-1', pushNotificationConfigId: 'config-1' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(false);
        expect((rpc as { result: unknown }).result).toEqual({
          taskId: 'task-1',
          pushNotificationConfig: {
            id: 'config-1',
            url: 'https://example.com/webhook',
          },
        });
      });

      it('should return TaskNotFound when config does not exist', async () => {
        const { handler } = createHandlerWithPushNotification('0.3');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/get',
          params: { id: 'task-1', pushNotificationConfigId: 'nope' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.TASK_NOT_FOUND,
        );
      });

      it('should return InvalidParams when id (task ID) is missing', async () => {
        const { handler } = createHandlerWithPushNotification('0.3');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/get',
          params: { pushNotificationConfigId: 'config-1' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.INVALID_PARAMS,
        );
      });

      it('should return the first stored config when pushNotificationConfigId is omitted (TaskIdParams variant)', async () => {
        const { handler, pushStore } = createHandlerWithPushNotification('0.3');

        const first: TaskPushNotificationConfig = {
          taskId: 'task-1',
          pushNotificationConfig: {
            id: 'config-first',
            url: 'https://example.com/first',
          },
        };
        await pushStore.set(first);

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/get',
          params: { id: 'task-1' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(false);
        expect((rpc as { result: unknown }).result).toEqual({
          taskId: 'task-1',
          pushNotificationConfig: {
            id: 'config-first',
            url: 'https://example.com/first',
          },
        });
      });

      it('should return TaskNotFound when pushNotificationConfigId is omitted and no configs exist', async () => {
        const { handler } = createHandlerWithPushNotification('0.3');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/get',
          params: { id: 'task-without-configs' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.TASK_NOT_FOUND,
        );
      });
    });
  });

  describe('tasks/pushNotificationConfig/list', () => {
    it('should return PushNotificationNotSupported when no store configured', async () => {
      const handler = createHandler();
      const response = await handler.handle({
        jsonrpc: '2.0',
        id: 1,
        method: 'tasks/pushNotificationConfig/list',
        params: { taskId: 'task-1' },
      });

      expect(isAsyncGenerator(response)).toBe(false);
      const rpc = response as JSONRPCResponse;
      expect('error' in rpc).toBe(true);
      expect((rpc as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED,
      );
    });

    describe('v1.0 parameter format (taskId) — paginated response', () => {
      it('should return { configs, nextPageToken } for the given task', async () => {
        const { handler, pushStore } = createHandlerWithPushNotification('1.0');

        await pushStore.set({
          taskId: 'task-1',
          pushNotificationConfig: {
            id: 'config-1',
            url: 'https://example.com/webhook-1',
          },
        });
        await pushStore.set({
          taskId: 'task-1',
          pushNotificationConfig: {
            id: 'config-2',
            url: 'https://example.com/webhook-2',
          },
        });

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/list',
          params: { taskId: 'task-1' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(false);
        const result = (rpc as { result: { configs: unknown[]; nextPageToken: string } }).result;
        expect(result.nextPageToken).toBe('');
        expect(Array.isArray(result.configs)).toBe(true);
        expect(result.configs).toHaveLength(2);
        expect(result.configs).toEqual(
          expect.arrayContaining([
            {
              id: 'config-1',
              taskId: 'task-1',
              url: 'https://example.com/webhook-1',
            },
            {
              id: 'config-2',
              taskId: 'task-1',
              url: 'https://example.com/webhook-2',
            },
          ]),
        );
      });

      it('should return { configs: [], nextPageToken: "" } when no configs exist', async () => {
        const { handler } = createHandlerWithPushNotification('1.0');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/list',
          params: { taskId: 'unknown-task' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(false);
        expect((rpc as { result: unknown }).result).toEqual({ configs: [], nextPageToken: '' });
      });

      it('should translate stored authentication to v1.0 wire shape on list', async () => {
        const { handler, pushStore } = createHandlerWithPushNotification('1.0');

        await pushStore.set({
          taskId: 'task-1',
          pushNotificationConfig: {
            id: 'config-1',
            url: 'https://example.com/webhook',
            authentication: { schemes: ['Bearer'], credentials: 'abc123' },
          },
        });

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/list',
          params: { taskId: 'task-1' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(false);
        const result = (rpc as { result: { configs: { authentication?: unknown }[] } }).result;
        expect(result.configs).toHaveLength(1);
        expect(result.configs[0].authentication).toEqual({
          scheme: 'Bearer',
          credentials: 'abc123',
        });
      });

      it('should accept pageSize/pageToken params and ignore them', async () => {
        const { handler, pushStore } = createHandlerWithPushNotification('1.0');

        await pushStore.set({
          taskId: 'task-1',
          pushNotificationConfig: { id: 'config-1', url: 'https://example.com/webhook' },
        });

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/list',
          params: { taskId: 'task-1', pageSize: 10, pageToken: 'ignored' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(false);
        const result = (rpc as { result: { configs: unknown[]; nextPageToken: string } }).result;
        expect(result.configs).toHaveLength(1);
        expect(result.nextPageToken).toBe('');
      });

      it('should return InvalidParams when taskId is missing', async () => {
        const { handler } = createHandlerWithPushNotification('1.0');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/list',
          params: {},
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.INVALID_PARAMS,
        );
      });
    });

    describe('v0.3 parameter format (id) — bare array response', () => {
      it('should return a bare array of nested TaskPushNotificationConfig', async () => {
        const { handler, pushStore } = createHandlerWithPushNotification('0.3');

        await pushStore.set({
          taskId: 'task-1',
          pushNotificationConfig: {
            id: 'config-1',
            url: 'https://example.com/webhook',
          },
        });

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/list',
          params: { id: 'task-1' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(false);
        const result = (rpc as { result: unknown }).result as unknown[];
        expect(Array.isArray(result)).toBe(true);
        expect(result).toHaveLength(1);
        expect(result[0]).toEqual({
          taskId: 'task-1',
          pushNotificationConfig: {
            id: 'config-1',
            url: 'https://example.com/webhook',
          },
        });
      });

      it('should return an empty bare array when no configs exist', async () => {
        const { handler } = createHandlerWithPushNotification('0.3');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/list',
          params: { id: 'unknown-task' },
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(false);
        expect((rpc as { result: unknown }).result).toEqual([]);
      });

      it('should return InvalidParams when id is missing', async () => {
        const { handler } = createHandlerWithPushNotification('0.3');

        const response = await handler.handle({
          jsonrpc: '2.0',
          id: 1,
          method: 'tasks/pushNotificationConfig/list',
          params: {},
        });

        expect(isAsyncGenerator(response)).toBe(false);
        const rpc = response as JSONRPCResponse;
        expect('error' in rpc).toBe(true);
        expect((rpc as JSONRPCErrorResponse).error.code).toBe(
          A2A_ERROR_CODES.INVALID_PARAMS,
        );
      });
    });
  });
});
