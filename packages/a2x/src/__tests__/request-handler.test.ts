import { describe, it, expect } from 'vitest';
import { DefaultRequestHandler } from '../transport/request-handler.js';
import { A2XAgent } from '../a2x/a2x-agent.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryTaskStore } from '../a2x/task-store.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { LlmAgent } from '../agent/llm-agent.js';
import { BaseLlmProvider } from '../provider/base.js';
import { A2A_ERROR_CODES } from '../types/errors.js';
import type { JSONRPCResponse, JSONRPCErrorResponse } from '../types/jsonrpc.js';

// Ensure mappers are registered
import '../a2x/index.js';

const mockProvider = new (class extends BaseLlmProvider {
  readonly name = 'mock';
  constructor() { super({ model: 'gpt-4' }); }
  async generateContent() {
    return { content: [], finishReason: 'stop' };
  }
})();

function createHandler(): DefaultRequestHandler {
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
  const a2xAgent = new A2XAgent(taskStore, executor);
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
      expect(task.status.state).toBe('completed');
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
      const generator = result as AsyncGenerator<{ status?: { state: string } }>;
      const events: unknown[] = [];

      for await (const event of generator) {
        events.push(event);
      }

      // Should have received events (status_update + artifact_updates + final status)
      expect(events.length).toBeGreaterThan(0);

      // First event should be a working status update
      const first = events[0] as { status?: { state: string } };
      expect(first.status?.state).toBe('working');

      // Last status event should be completed
      const statusEvents = events.filter(
        (e) => (e as { status?: unknown }).status !== undefined,
      );
      const lastStatus = statusEvents[statusEvents.length - 1] as { status: { state: string } };
      expect(lastStatus.status.state).toBe('completed');
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
});
