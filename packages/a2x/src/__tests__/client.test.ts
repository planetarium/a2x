import { describe, it, expect, vi } from 'vitest';
import { A2XClient } from '../client/a2x-client.js';
import {
  resolveAgentCard,
  detectProtocolVersion,
  getAgentEndpointUrl,
  AGENT_CARD_WELL_KNOWN_PATH,
} from '../client/agent-card-resolver.js';
import { getResponseParser } from '../client/response-parser.js';
import { parseSSEStream } from '../client/sse-parser.js';
import { TaskState } from '../types/task.js';
import { A2A_ERROR_CODES } from '../types/errors.js';
import type { AgentCardV03, AgentCardV10 } from '../types/agent-card.js';

// ─── Test Fixtures ───

const V03_CARD: AgentCardV03 = {
  name: 'Test Agent',
  description: 'A test agent',
  version: '1.0.0',
  url: 'http://localhost:4000/a2a',
  protocolVersion: '0.3.0',
  preferredTransport: 'JSONRPC',
  capabilities: { streaming: true },
  skills: [],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
};

const V10_CARD: AgentCardV10 = {
  name: 'Test Agent',
  description: 'A test agent',
  version: '1.0.0',
  supportedInterfaces: [
    { url: 'http://localhost:4000/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
  ],
  capabilities: { streaming: true },
  skills: [],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
};

function createJsonRpcSuccess(result: unknown) {
  return { jsonrpc: '2.0', id: 1, result };
}

function createJsonRpcError(code: number, message: string) {
  return { jsonrpc: '2.0', id: 1, error: { code, message } };
}

function createMockFetch(responseBody: unknown, options?: { status?: number; contentType?: string }) {
  return vi.fn().mockResolvedValue({
    ok: (options?.status ?? 200) < 400,
    status: options?.status ?? 200,
    statusText: options?.status === 404 ? 'Not Found' : 'OK',
    json: () => Promise.resolve(responseBody),
    headers: new Headers({ 'Content-Type': options?.contentType ?? 'application/json' }),
  });
}

function createSSEResponse(events: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(events));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: stream,
    headers: new Headers({ 'Content-Type': 'text/event-stream' }),
  } as unknown as Response;
}

function createSendMessageParams(text: string) {
  return {
    message: {
      messageId: 'msg-1',
      role: 'user' as const,
      parts: [{ text }],
    },
  };
}

// ═══ AgentCardResolver Tests ═══

describe('AgentCardResolver', () => {
  describe('detectProtocolVersion', () => {
    it('should detect v0.3 from top-level url field', () => {
      expect(detectProtocolVersion({ url: 'http://localhost', protocolVersion: '0.3.0' })).toBe('0.3');
    });

    it('should detect v1.0 from supportedInterfaces', () => {
      expect(detectProtocolVersion({ supportedInterfaces: [{ url: 'http://localhost' }] })).toBe('1.0');
    });

    it('should default to 1.0 for ambiguous structure', () => {
      expect(detectProtocolVersion({})).toBe('1.0');
    });

    it('should prefer v1.0 when both url and supportedInterfaces exist', () => {
      expect(detectProtocolVersion({
        url: 'http://localhost',
        supportedInterfaces: [{ url: 'http://localhost' }],
      })).toBe('1.0');
    });

    it('should detect v0.3 when card declares protocolVersion 0.3.x even if supportedInterfaces is present', () => {
      // Regression: v0.3 cards may legally advertise supportedInterfaces for extra
      // transports. The declared protocolVersion must win over shape inference.
      expect(detectProtocolVersion({
        protocolVersion: '0.3.0',
        url: 'http://localhost',
        supportedInterfaces: [
          { url: 'http://localhost', protocolBinding: 'JSONRPC', protocolVersion: '0.3' },
        ],
      })).toBe('0.3');
    });

    it('should accept short major.minor protocolVersion strings', () => {
      expect(detectProtocolVersion({ protocolVersion: '0.3' })).toBe('0.3');
      expect(detectProtocolVersion({ protocolVersion: '1.0' })).toBe('1.0');
    });

    it('should detect v1.0 from declared protocolVersion 1.x', () => {
      expect(detectProtocolVersion({ protocolVersion: '1.0.0' })).toBe('1.0');
    });

    it('should fall back to shape inference when protocolVersion is unrecognized', () => {
      expect(detectProtocolVersion({
        protocolVersion: '2.0.0',
        url: 'http://localhost',
      })).toBe('0.3');
      expect(detectProtocolVersion({
        protocolVersion: '',
        supportedInterfaces: [{ url: 'http://localhost' }],
      })).toBe('1.0');
    });
  });

  describe('getAgentEndpointUrl', () => {
    it('should return url from v0.3 card', () => {
      expect(getAgentEndpointUrl(V03_CARD, '0.3')).toBe('http://localhost:4000/a2a');
    });

    it('should return JSONRPC interface url from v1.0 card', () => {
      expect(getAgentEndpointUrl(V10_CARD, '1.0')).toBe('http://localhost:4000/a2a');
    });

    it('should prefer JSONRPC binding in v1.0 card with multiple interfaces', () => {
      const card: AgentCardV10 = {
        ...V10_CARD,
        supportedInterfaces: [
          { url: 'http://localhost/grpc', protocolBinding: 'GRPC', protocolVersion: '1.0' },
          { url: 'http://localhost/jsonrpc', protocolBinding: 'JSONRPC', protocolVersion: '1.0' },
        ],
      };
      expect(getAgentEndpointUrl(card, '1.0')).toBe('http://localhost/jsonrpc');
    });

    it('should fallback to first interface if no JSONRPC in v1.0', () => {
      const card: AgentCardV10 = {
        ...V10_CARD,
        supportedInterfaces: [
          { url: 'http://localhost/grpc', protocolBinding: 'GRPC', protocolVersion: '1.0' },
        ],
      };
      expect(getAgentEndpointUrl(card, '1.0')).toBe('http://localhost/grpc');
    });

    it('should throw for v0.3 card without url', () => {
      const card = { ...V03_CARD, url: '' };
      expect(() => getAgentEndpointUrl(card, '0.3')).toThrow('missing required "url"');
    });

    it('should throw for v1.0 card with empty supportedInterfaces', () => {
      const card = { ...V10_CARD, supportedInterfaces: [] };
      expect(() => getAgentEndpointUrl(card, '1.0')).toThrow('no supportedInterfaces');
    });
  });

  describe('resolveAgentCard', () => {
    it('should fetch and resolve a v0.3 card', async () => {
      const mockFetch = createMockFetch(V03_CARD);
      const result = await resolveAgentCard('http://localhost:4000', { fetch: mockFetch });

      expect(result.version).toBe('0.3');
      expect(result.card).toEqual(V03_CARD);
      expect(result.baseUrl).toBe('http://localhost:4000');
      expect(mockFetch).toHaveBeenCalledWith(
        `http://localhost:4000${AGENT_CARD_WELL_KNOWN_PATH}`,
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('should fetch and resolve a v1.0 card', async () => {
      const mockFetch = createMockFetch(V10_CARD);
      const result = await resolveAgentCard('http://localhost:4000', { fetch: mockFetch });

      expect(result.version).toBe('1.0');
      expect(result.card).toEqual(V10_CARD);
    });

    it('should strip trailing slash from baseUrl', async () => {
      const mockFetch = createMockFetch(V10_CARD);
      await resolveAgentCard('http://localhost:4000/', { fetch: mockFetch });

      expect(mockFetch).toHaveBeenCalledWith(
        `http://localhost:4000${AGENT_CARD_WELL_KNOWN_PATH}`,
        expect.any(Object),
      );
    });

    it('should support custom path', async () => {
      const mockFetch = createMockFetch(V10_CARD);
      await resolveAgentCard('http://localhost:4000', { fetch: mockFetch, path: '/custom/card.json' });

      expect(mockFetch).toHaveBeenCalledWith(
        'http://localhost:4000/custom/card.json',
        expect.any(Object),
      );
    });

    it('should throw on HTTP error', async () => {
      const mockFetch = createMockFetch({}, { status: 404 });
      await expect(
        resolveAgentCard('http://localhost:4000', { fetch: mockFetch }),
      ).rejects.toThrow('Failed to fetch AgentCard');
    });

    it('should pass custom headers', async () => {
      const mockFetch = createMockFetch(V10_CARD);
      await resolveAgentCard('http://localhost:4000', {
        fetch: mockFetch,
        headers: { Authorization: 'Bearer token123' },
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer token123' }),
        }),
      );
    });
  });
});

// ═══ ResponseParser Tests ═══

describe('ResponseParser', () => {
  describe('V03ResponseParser', () => {
    const parser = getResponseParser('0.3');

    it('should strip kind from task', () => {
      const raw = {
        kind: 'task',
        id: 'task-1',
        status: { state: 'working', message: { kind: 'message', messageId: 'm1', role: 'agent', parts: [{ kind: 'text', text: 'hi' }] } },
      };
      const task = parser.parseTask(raw);
      expect(task.id).toBe('task-1');
      expect(task.status.state).toBe(TaskState.WORKING);
      expect((task as Record<string, unknown>).kind).toBeUndefined();
    });

    it('should strip kind from artifacts in task', () => {
      const raw = {
        kind: 'task',
        id: 'task-1',
        status: { state: 'completed' },
        artifacts: [{ kind: 'artifact', artifactId: 'a1', name: 'response', parts: [{ kind: 'text', text: 'result' }] }],
      };
      const task = parser.parseTask(raw);
      expect(task.artifacts![0].artifactId).toBe('a1');
      expect((task.artifacts![0] as Record<string, unknown>).kind).toBeUndefined();
      expect((task.artifacts![0].parts[0] as Record<string, unknown>).kind).toBeUndefined();
    });

    it('should strip kind from status update event', () => {
      const raw = {
        kind: 'status-update',
        taskId: 'task-1',
        contextId: 'ctx-1',
        status: { state: 'working' },
      };
      const event = parser.parseStatusUpdateEvent(raw);
      expect(event.taskId).toBe('task-1');
      expect((event as Record<string, unknown>).kind).toBeUndefined();
    });

    it('should strip kind from artifact update event', () => {
      const raw = {
        kind: 'artifact-update',
        taskId: 'task-1',
        contextId: 'ctx-1',
        artifact: { kind: 'artifact', artifactId: 'a1', parts: [{ kind: 'text', text: 'chunk' }] },
      };
      const event = parser.parseArtifactUpdateEvent(raw);
      expect(event.artifact.artifactId).toBe('a1');
      expect((event.artifact as Record<string, unknown>).kind).toBeUndefined();
    });
  });

  describe('V10ResponseParser', () => {
    const parser = getResponseParser('1.0');

    it('should convert TASK_STATE_WORKING to working', () => {
      const raw = { id: 'task-1', status: { state: 'TASK_STATE_WORKING' } };
      const task = parser.parseTask(raw);
      expect(task.status.state).toBe(TaskState.WORKING);
    });

    it('should convert TASK_STATE_COMPLETED to completed', () => {
      const raw = { id: 'task-1', status: { state: 'TASK_STATE_COMPLETED' } };
      const task = parser.parseTask(raw);
      expect(task.status.state).toBe(TaskState.COMPLETED);
    });

    it('should convert TASK_STATE_FAILED to failed', () => {
      const raw = { id: 'task-1', status: { state: 'TASK_STATE_FAILED' } };
      const task = parser.parseTask(raw);
      expect(task.status.state).toBe(TaskState.FAILED);
    });

    it('should convert TASK_STATE_UNSPECIFIED to unknown', () => {
      // v0.3 `unknown` ↔ v1.0 `TASK_STATE_UNSPECIFIED` (proto default,
      // documented as "unknown or indeterminate state"). A v1.0 server
      // emitting the default value must round-trip cleanly, not throw.
      // See #121.
      const raw = { id: 'task-1', status: { state: 'TASK_STATE_UNSPECIFIED' } };
      const task = parser.parseTask(raw);
      expect(task.status.state).toBe(TaskState.UNKNOWN);
    });

    it('should pass through already lowercase states', () => {
      const raw = { id: 'task-1', status: { state: 'completed' } };
      const task = parser.parseTask(raw);
      expect(task.status.state).toBe(TaskState.COMPLETED);
    });

    it('should throw on unknown state', () => {
      const raw = { id: 'task-1', status: { state: 'INVALID_STATE' } };
      expect(() => parser.parseTask(raw)).toThrow('Unknown task state');
    });

    it('should convert status update event state', () => {
      const raw = { taskId: 'task-1', contextId: 'ctx-1', status: { state: 'TASK_STATE_SUBMITTED' } };
      const event = parser.parseStatusUpdateEvent(raw);
      expect(event.status.state).toBe(TaskState.SUBMITTED);
    });

    it('should pass through artifact update events unchanged', () => {
      const raw = { taskId: 'task-1', contextId: 'ctx-1', artifact: { artifactId: 'a1', parts: [{ text: 'hi' }] } };
      const event = parser.parseArtifactUpdateEvent(raw);
      expect(event.artifact.parts[0]).toEqual({ text: 'hi' });
    });
  });
});

// ═══ SSE Parser Tests ═══

describe('SSE Parser', () => {
  const parser = getResponseParser('0.3');

  it('parses spec-shaped JSON-RPC envelopes for status and artifact updates', async () => {
    // Spec a2a-v0.3 §SendStreamingMessageSuccessResponse: each chunk is
    // a full JSON-RPC success response with the event under `result`.
    const sse = [
      'data: {"jsonrpc":"2.0","id":1,"result":{"kind":"status-update","taskId":"t1","contextId":"c1","status":{"state":"working"}}}\n\n',
      'data: {"jsonrpc":"2.0","id":1,"result":{"kind":"artifact-update","taskId":"t1","contextId":"c1","artifact":{"artifactId":"a1","parts":[{"kind":"text","text":"hello"}]}}}\n\n',
    ].join('');

    const response = createSSEResponse(sse);
    const events: unknown[] = [];
    for await (const event of parseSSEStream(response, parser)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect((events[0] as Record<string, unknown>).taskId).toBe('t1');
    expect((events[1] as Record<string, unknown>).taskId).toBe('t1');
  });

  it('stops at terminal status with final=true (no `event: done` terminator needed)', async () => {
    // Spec a2a-v0.3 §TaskStatusUpdateEvent: `final: true` on a terminal
    // state marks the last event for the stream. Connection close after
    // it ends the SSE stream.
    const sse = [
      'data: {"jsonrpc":"2.0","id":1,"result":{"kind":"status-update","taskId":"t1","contextId":"c1","status":{"state":"working"}}}\n\n',
      'data: {"jsonrpc":"2.0","id":1,"result":{"kind":"status-update","taskId":"t1","contextId":"c1","status":{"state":"completed"},"final":true}}\n\n',
    ].join('');

    const response = createSSEResponse(sse);
    const events: unknown[] = [];
    for await (const event of parseSSEStream(response, parser)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
  });

  it('handles chunked SSE delivery for spec-shaped envelopes', async () => {
    const encoder = new TextEncoder();
    const chunk1 = 'data: {"jsonrpc":"2.0","id":1,"result":{"kind":"status-upda';
    const chunk2 =
      'te","taskId":"t1","contextId":"c1","status":{"state":"working"}}}\n\n';

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(chunk1));
        controller.enqueue(encoder.encode(chunk2));
        controller.close();
      },
    });

    const response = { ok: true, body: stream } as unknown as Response;
    const events: unknown[] = [];
    for await (const event of parseSSEStream(response, parser)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
    expect((events[0] as Record<string, unknown>).taskId).toBe('t1');
  });

  it('still parses the legacy `event: status_update` / `event: done` format with a deprecation warning', async () => {
    // Backward-compat: pre-#118 a2x servers emitted `event: ` framed
    // chunks. Keep parsing them for one minor so users don't break on
    // an old server, but log once so they notice the upgrade.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const sse = [
        'event: status_update\ndata: {"kind":"status-update","taskId":"t1","contextId":"c1","status":{"state":"working"}}\n\n',
        'event: done\ndata: {}\n\n',
      ].join('');

      const response = createSSEResponse(sse);
      const events: unknown[] = [];
      for await (const event of parseSSEStream(response, parser)) {
        events.push(event);
      }

      expect(events).toHaveLength(1);
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain('legacy SSE format');
    } finally {
      warn.mockRestore();
    }
  });

  it('should throw if response body is null', async () => {
    const response = { ok: true, body: null } as unknown as Response;

    await expect(async () => {
      for await (const _event of parseSSEStream(response, parser)) { /* */ }
    }).rejects.toThrow('Response body is null');
  });

  // Issue #142 fix 6: a server that yields a JSON-RPC error envelope
  // mid-stream (request-handler.ts:_wrapStreamInJsonRpc) was previously
  // treated as `MESSAGE` event with no switch arm — silently dropped.
  // The parser must surface it as a thrown error so the caller knows
  // the stream failed.
  it('throws when the server yields a mid-stream JSON-RPC error envelope', async () => {
    const sse = [
      'data: {"jsonrpc":"2.0","id":1,"result":{"kind":"status-update","taskId":"t1","contextId":"c1","status":{"state":"working"}}}\n\n',
      'data: {"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"executor exploded"}}\n\n',
    ].join('');

    const response = createSSEResponse(sse);
    const events: unknown[] = [];
    await expect(async () => {
      for await (const event of parseSSEStream(response, parser)) {
        events.push(event);
      }
    }).rejects.toThrow('executor exploded');

    // The first chunk is a normal status update — the parser must yield
    // it before the error terminates the stream.
    expect(events).toHaveLength(1);
  });
});

// ═══ A2XClient Tests ═══

describe('A2XClient', () => {
  describe('constructor', () => {
    it('should accept a URL string', () => {
      const client = new A2XClient('http://localhost:4000');
      expect(client).toBeDefined();
    });

    it('should accept a v0.3 AgentCard', () => {
      const client = new A2XClient(V03_CARD);
      expect(client).toBeDefined();
    });

    it('should accept a v1.0 AgentCard', () => {
      const client = new A2XClient(V10_CARD);
      expect(client).toBeDefined();
    });
  });

  describe('getAgentCard', () => {
    it('should resolve and cache agent card from URL', async () => {
      const mockFetch = createMockFetch(V10_CARD);
      const client = new A2XClient('http://localhost:4000', { fetch: mockFetch });

      const card = await client.getAgentCard();
      expect(card).toEqual(V10_CARD);

      // Second call should use cache (no additional fetch)
      const card2 = await client.getAgentCard();
      expect(card2).toEqual(V10_CARD);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should return pre-provided AgentCard without fetch', async () => {
      const mockFetch = vi.fn();
      const client = new A2XClient(V03_CARD, { fetch: mockFetch });

      const card = await client.getAgentCard();
      expect(card).toEqual(V03_CARD);
      expect(mockFetch).not.toHaveBeenCalled();
    });
  });

  describe('sendMessage', () => {
    it('should send JSON-RPC request and parse v0.3 task response', async () => {
      const v03Task = {
        kind: 'task',
        id: 'task-1',
        status: { state: 'completed' },
        artifacts: [{ kind: 'artifact', artifactId: 'a1', name: 'response', parts: [{ kind: 'text', text: 'Hello!' }] }],
      };

      const mockFetch = createMockFetch(createJsonRpcSuccess(v03Task));
      const client = new A2XClient(V03_CARD, { fetch: mockFetch });

      const task = await client.sendMessage(createSendMessageParams('Hi'));
      expect(task.id).toBe('task-1');
      expect(task.status.state).toBe(TaskState.COMPLETED);
      expect((task as Record<string, unknown>).kind).toBeUndefined();
      expect(task.artifacts![0].parts[0]).toEqual({ text: 'Hello!' });
    });

    it('should send JSON-RPC request and parse v1.0 task response', async () => {
      const v10Task = {
        id: 'task-1',
        status: { state: 'TASK_STATE_COMPLETED' },
        artifacts: [{ artifactId: 'a1', parts: [{ text: 'Hello!' }] }],
      };

      const mockFetch = createMockFetch(createJsonRpcSuccess(v10Task));
      const client = new A2XClient(V10_CARD, { fetch: mockFetch });

      const task = await client.sendMessage(createSendMessageParams('Hi'));
      expect(task.id).toBe('task-1');
      expect(task.status.state).toBe(TaskState.COMPLETED);
    });

    it('should build correct JSON-RPC request', async () => {
      const mockFetch = createMockFetch(createJsonRpcSuccess({ id: 't1', status: { state: 'completed' } }));
      const client = new A2XClient(V03_CARD, { fetch: mockFetch });

      await client.sendMessage(createSendMessageParams('Test'));

      const callArgs = mockFetch.mock.calls[0];
      const body = JSON.parse(callArgs[1].body);
      expect(body.jsonrpc).toBe('2.0');
      expect(body.method).toBe('message/send');
      expect(body.params.message.parts[0].text).toBe('Test');
      expect(typeof body.id).toBe('number');
    });

    it('should throw TaskNotFoundError on -32001 error', async () => {
      const mockFetch = createMockFetch(createJsonRpcError(A2A_ERROR_CODES.TASK_NOT_FOUND, 'Task not found'));
      const client = new A2XClient(V03_CARD, { fetch: mockFetch });

      await expect(client.sendMessage(createSendMessageParams('Hi'))).rejects.toThrow('Task not found');
    });

    it('should throw InternalError on HTTP failure', async () => {
      const mockFetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        statusText: 'Internal Server Error',
      });
      const client = new A2XClient(V03_CARD, { fetch: mockFetch });

      await expect(client.sendMessage(createSendMessageParams('Hi'))).rejects.toThrow('HTTP 500');
    });

    it('should pass custom headers', async () => {
      const mockFetch = createMockFetch(createJsonRpcSuccess({ id: 't1', status: { state: 'completed' } }));
      const client = new A2XClient(V03_CARD, {
        fetch: mockFetch,
        headers: { Authorization: 'Bearer secret' },
      });

      await client.sendMessage(createSendMessageParams('Hi'));

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].headers.Authorization).toBe('Bearer secret');
    });
  });

  describe('sendMessageStream', () => {
    it('should stream events from v0.3 server', async () => {
      // First call: resolveAgentCard (URL-based), but using AgentCard directly
      const sseText = [
        'event: status_update\ndata: {"kind":"status-update","taskId":"t1","contextId":"c1","status":{"state":"working"}}\n\n',
        'event: artifact_update\ndata: {"kind":"artifact-update","taskId":"t1","contextId":"c1","artifact":{"kind":"artifact","artifactId":"a1","parts":[{"kind":"text","text":"Hi!"}]}}\n\n',
        'event: done\ndata: {}\n\n',
      ].join('');

      const sseResponse = createSSEResponse(sseText);
      const mockFetch = vi.fn().mockResolvedValue(sseResponse);
      const client = new A2XClient(V03_CARD, { fetch: mockFetch });

      const events: unknown[] = [];
      for await (const event of client.sendMessageStream(createSendMessageParams('Hi'))) {
        events.push(event);
      }

      expect(events).toHaveLength(2);
    });

    it('should include Accept header for SSE', async () => {
      const sseResponse = createSSEResponse('event: done\ndata: {}\n\n');
      const mockFetch = vi.fn().mockResolvedValue(sseResponse);
      const client = new A2XClient(V03_CARD, { fetch: mockFetch });

      for await (const _event of client.sendMessageStream(createSendMessageParams('Hi'))) { /* */ }

      const callArgs = mockFetch.mock.calls[0];
      expect(callArgs[1].headers.Accept).toBe('text/event-stream');
    });
  });

  describe('getTask', () => {
    it('should retrieve and parse task', async () => {
      const mockFetch = createMockFetch(
        createJsonRpcSuccess({ id: 'task-1', status: { state: 'completed' }, artifacts: [] }),
      );
      const client = new A2XClient(V03_CARD, { fetch: mockFetch });

      const task = await client.getTask('task-1');
      expect(task.id).toBe('task-1');
      expect(task.status.state).toBe(TaskState.COMPLETED);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe('tasks/get');
      expect(body.params.id).toBe('task-1');
    });
  });

  describe('cancelTask', () => {
    it('should cancel and parse task', async () => {
      const mockFetch = createMockFetch(
        createJsonRpcSuccess({ id: 'task-1', status: { state: 'canceled' } }),
      );
      const client = new A2XClient(V03_CARD, { fetch: mockFetch });

      const task = await client.cancelTask('task-1');
      expect(task.id).toBe('task-1');
      expect(task.status.state).toBe(TaskState.CANCELED);

      const body = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(body.method).toBe('tasks/cancel');
    });
  });

  describe('URL-based resolution', () => {
    it('should resolve agent card from URL on first method call', async () => {
      let callCount = 0;
      const mockFetch = vi.fn().mockImplementation((url: string) => {
        callCount++;
        if (url.includes('.well-known')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(V03_CARD),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(
            createJsonRpcSuccess({ id: 'task-1', status: { state: 'completed' } }),
          ),
        });
      });

      const client = new A2XClient('http://localhost:4000', { fetch: mockFetch });
      const task = await client.sendMessage(createSendMessageParams('Hi'));

      expect(task.id).toBe('task-1');
      // First call: agent card resolution, second call: sendMessage
      expect(callCount).toBe(2);
    });
  });
});
