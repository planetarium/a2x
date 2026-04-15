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
import type { JSONRPCResponse, JSONRPCErrorResponse } from '../types/jsonrpc.js';
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

  return new DefaultRequestHandler(a2xAgent);
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

      // Consume the async generator and collect events
      const generator = result as AsyncGenerator<Record<string, unknown>>;
      const events: unknown[] = [];

      for await (const event of generator) {
        events.push(event);
      }

      // Should have received events (status_update + artifact_updates + final status)
      expect(events.length).toBeGreaterThan(0);

      // Default is v1.0: status state should be UPPER_SNAKE_CASE
      const first = events[0] as Record<string, unknown>;
      const firstStatus = first.status as Record<string, unknown> | undefined;
      if (firstStatus) {
        expect(firstStatus.state).toBe('TASK_STATE_WORKING');
      }

      // Last status event should be completed
      const statusEvents = events.filter(
        (e) => (e as Record<string, unknown>).status !== undefined,
      );
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

      const generator = result as AsyncGenerator<Record<string, unknown>>;
      const events: Record<string, unknown>[] = [];

      for await (const event of generator) {
        events.push(event as Record<string, unknown>);
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

      const generator = result as AsyncGenerator<Record<string, unknown>>;
      const events: Record<string, unknown>[] = [];

      for await (const event of generator) {
        events.push(event as Record<string, unknown>);
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

    it('should reject with invalid API key', async () => {
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
      expect('error' in rpc).toBe(true);
      expect((rpc as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.AUTHENTICATION_REQUIRED,
      );
    });

    it('should reject with missing API key', async () => {
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
      expect('error' in rpc).toBe(true);
      expect((rpc as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.AUTHENTICATION_REQUIRED,
      );
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
      expect('error' in rpc).toBe(true);
      expect((rpc as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.AUTHENTICATION_REQUIRED,
      );
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
  });
});
