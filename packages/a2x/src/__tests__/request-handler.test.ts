import { describe, it, expect } from 'vitest';
import { DefaultRequestHandler } from '../transport/request-handler.js';
import { A2XAgent } from '../a2x/a2x-agent.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryTaskStore } from '../a2x/task-store.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { LlmAgent } from '../agent/llm-agent.js';
import { A2A_ERROR_CODES } from '../types/errors.js';
import type { JSONRPCRequest, JSONRPCResponse, JSONRPCErrorResponse } from '../types/jsonrpc.js';

// Ensure mappers are registered
import '../a2x/index.js';

function createHandler(): DefaultRequestHandler {
  const agent = new LlmAgent({
    name: 'test-agent',
    model: 'gpt-4',
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

describe('Layer 4: DefaultRequestHandler', () => {
  describe('JSON-RPC error handling', () => {
    it('should return parse error for invalid JSON string', async () => {
      const handler = createHandler();
      const response = await handler.handle('not json');

      expect(response.jsonrpc).toBe('2.0');
      expect(response.id).toBeNull();
      expect('error' in response).toBe(true);
      expect((response as JSONRPCErrorResponse).error.code).toBe(
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

      expect('error' in response).toBe(true);
      expect((response as JSONRPCErrorResponse).error.code).toBe(
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

      expect('error' in response).toBe(true);
      expect((response as JSONRPCErrorResponse).error.code).toBe(
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

      expect('result' in response).toBe(true);
      const task = (response as { result: unknown }).result as { id: string; status: { state: string } };
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

      expect('error' in response).toBe(true);
      expect((response as JSONRPCErrorResponse).error.code).toBe(
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

      expect('error' in response).toBe(true);
      expect((response as JSONRPCErrorResponse).error.code).toBe(
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

      const task = (sendResponse as { result: unknown }).result as { id: string };

      // Get the task
      const getResponse = await handler.handle({
        jsonrpc: '2.0',
        id: 2,
        method: 'tasks/get',
        params: { id: task.id },
      });

      expect('result' in getResponse).toBe(true);
      const retrieved = (getResponse as { result: unknown }).result as { id: string };
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

      expect('error' in response).toBe(true);
      expect((response as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.TASK_NOT_FOUND,
      );
    });
  });

  describe('message/stream', () => {
    it('should return unsupported operation when called via handle()', async () => {
      const handler = createHandler();
      const response = await handler.handle({
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

      expect('error' in response).toBe(true);
      expect((response as JSONRPCErrorResponse).error.code).toBe(
        A2A_ERROR_CODES.UNSUPPORTED_OPERATION,
      );
    });

    it('should return a ReadableStream via handleStream()', async () => {
      const handler = createHandler();
      const stream = handler.handleStream({
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

      expect(stream).toBeInstanceOf(ReadableStream);

      // Read all events from the stream
      const reader = stream.getReader();
      const decoder = new TextDecoder();
      const events: string[] = [];

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        events.push(decoder.decode(value));
      }

      // Should have received at least some SSE events
      expect(events.length).toBeGreaterThan(0);
      // Should contain event/data format
      const allText = events.join('');
      expect(allText).toContain('event:');
      expect(allText).toContain('data:');
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
