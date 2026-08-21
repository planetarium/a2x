import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import { Readable } from 'node:stream';
import { BaseAgent } from '../agent/base-agent.js';
import type { AgentEvent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';
import { A2XClient } from '../client/a2x-client.js';
import type { AuthProvider } from '../client/auth-provider.js';
import { ApiKeyAuthScheme } from '../client/auth-scheme.js';
import { A2A_TRANSPORTS } from '../client/client-transport.js';
import { selectAgentInterface } from '../client/agent-card-resolver.js';
import { createA2xRequestListener } from '../transport/to-a2x.js';
import { TaskNotFoundError } from '../types/errors.js';
import type { AgentCardV10 } from '../types/agent-card.js';
import { A2XServer } from '../a2x/a2x-agent.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { InMemoryTaskStore } from '../a2x/task-store.js';
import { InMemoryPushNotificationConfigStore } from '../a2x/push-notification-config-store.js';
import { DefaultRequestHandler } from '../transport/request-handler.js';
import { HttpJsonRequestHandler } from '../transport/http-json-handler.js';
import { ApiKeyAuthorization } from '../security/api-key.js';
import '../a2x/index.js';

class RestTestAgent extends BaseAgent {
  lastSignal: AbortSignal | undefined;

  constructor() {
    super({ name: 'rest-agent', description: 'REST integration test agent' });
  }

  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    this.lastSignal = context.signal;
    const part = context.message?.parts[0];
    const text = part && 'text' in part ? part.text : '';
    const chunkCount = ['cancel', 'disconnect', 'resubscribe'].includes(text)
      ? 50
      : 1;
    for (let index = 0; index < chunkCount; index += 1) {
      if (context.signal?.aborted) return;
      yield { type: 'text', text: `chunk-${index}`, role: 'agent' };
      if (chunkCount > 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
    yield { type: 'done' };
  }
}

function message(text = 'hello') {
  return {
    message: {
      messageId: crypto.randomUUID(),
      role: 'user' as const,
      parts: [{ text }],
    },
  };
}

describe('A2A v1.0 HTTP+JSON transport', () => {
  let baseUrl: string;
  let client: A2XClient;
  let close: () => Promise<void>;
  let testAgent: RestTestAgent;
  let requestListener: ReturnType<typeof createA2xRequestListener>;

  beforeAll(async () => {
    testAgent = new RestTestAgent();
    const runner = new InMemoryRunner({ agent: testAgent, appName: 'rest-test' });
    const executor = new AgentExecutor({
      runner,
      runConfig: { streamingMode: StreamingMode.SSE },
    });
    const a2xServer = new A2XServer({
      taskStore: new InMemoryTaskStore(),
      executor,
      protocolVersion: '1.0',
      pushNotificationConfigStore: new InMemoryPushNotificationConfigStore(),
    })
      .setDefaultUrl('http://127.0.0.1/a2a')
      .setDefaultTransport(A2A_TRANSPORTS.HTTP_JSON)
      .addSecurityScheme(
        'apiKey',
        new ApiKeyAuthorization({
          in: 'header',
          name: 'x-api-key',
          keys: ['secret-123'],
        }),
      )
      .addSecurityRequirement({ apiKey: [] })
      .setAuthenticatedExtendedCardProvider(() => ({
        description: 'Authenticated REST agent',
      }));
    const handler = new DefaultRequestHandler(a2xServer);
    const httpJsonHandler = new HttpJsonRequestHandler(handler, {
      basePath: '/a2a',
    });
    requestListener = createA2xRequestListener(handler, 'http://localhost', {
      httpJsonHandler,
      jsonRpcEnabled: false,
    });
    const server = createServer(requestListener);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    baseUrl = `http://127.0.0.1:${port}`;
    a2xServer.setDefaultUrl(`${baseUrl}/a2a`);
    const authProvider: AuthProvider = {
      async provide(requirements) {
        const scheme = requirements.flat().find(
          (candidate) => candidate instanceof ApiKeyAuthScheme,
        );
        if (!(scheme instanceof ApiKeyAuthScheme)) {
          throw new Error('Expected API key authentication');
        }
        return [scheme.setCredential('secret-123')];
      },
    };
    client = new A2XClient(baseUrl, { authProvider });
    close = () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      });
  });

  afterAll(async () => close?.());

  it('discovers an HTTP+JSON-only AgentCard and completes unary calls', async () => {
    const card = (await client.getAgentCard()) as AgentCardV10;
    expect(card.supportedInterfaces).toEqual([
      expect.objectContaining({ protocolBinding: 'HTTP+JSON' }),
    ]);

    const sent = await client.sendMessage(message());
    expect(sent.status.state).toBe('completed');

    const fetched = await client.getTask(sent.id);
    expect(fetched.id).toBe(sent.id);
  });

  it('does not expose an unconfigured JSON-RPC endpoint', async () => {
    const response = await fetch(`${baseUrl}/a2a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'SendMessage',
        params: message(),
      }),
    });
    expect(response.status).toBe(404);
  });

  it('accepts the v1.0 tenant path binding', async () => {
    const response = await fetch(`${baseUrl}/a2a/acme/message:send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/a2a+json',
        'A2A-Version': '1.0',
        'x-api-key': 'secret-123',
      },
      body: JSON.stringify(message('tenant path')),
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      task: { status: { state: 'TASK_STATE_COMPLETED' } },
    });
  });

  it('streams protobuf-shaped StreamResponse wrappers over SSE', async () => {
    const events = [];
    for await (const event of client.sendMessageStream(message('stream'))) {
      events.push(event);
    }
    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toEqual(
      expect.objectContaining({ taskId: expect.any(String) }),
    );
  });

  it('cancels a live task over REST', async () => {
    const stream = client.sendMessageStream(message('cancel'));
    const first = await stream.next();
    expect(first.done).toBe(false);
    const taskId = first.value?.taskId;
    expect(taskId).toEqual(expect.any(String));

    const canceled = await client.cancelTask(taskId!);
    expect(canceled.status.state).toBe('canceled');
    await stream.return(undefined);
  });

  it('resubscribes over REST and receives the required initial snapshot', async () => {
    const stream = client.sendMessageStream(message('resubscribe'));
    const first = await stream.next();
    const taskId = first.value?.taskId;
    expect(taskId).toEqual(expect.any(String));

    const subscription = client.subscribeTask(taskId!);
    const snapshot = await subscription.next();
    expect(snapshot.done).toBe(false);
    expect(snapshot.value?.taskId).toBe(taskId);

    await subscription.return(undefined);
    await stream.return(undefined);
  });

  it('propagates an early REST stream exit to the agent AbortSignal', async () => {
    const stream = client.sendMessageStream(message('disconnect'));
    await stream.next();
    const signal = testAgent.lastSignal;
    expect(signal?.aborted).toBe(false);

    await stream.return(undefined);
    await expect(
      waitUntil(() => signal?.aborted === true, 500),
    ).resolves.toBe(true);
  });

  it('surfaces a REST mid-stream error and terminates the subscription', async () => {
    const subscription = client.subscribeTask('missing-stream-task');
    await expect(subscription.next()).rejects.toThrow('Task not found');
  });

  it('lists tasks with REST query parameters and normalized task states', async () => {
    const result = await client.listTasks({ pageSize: 10, includeArtifacts: false });
    expect(result.pageSize).toBe(10);
    expect(result.totalSize).toBeGreaterThan(0);
    expect(result.tasks[0]?.status.state).toBe('completed');
  });

  it('rejects invalid REST boolean query parameters', async () => {
    const response = await fetch(
      `${baseUrl}/a2a/tasks?includeArtifacts=maybe`,
      { headers: { 'x-api-key': 'secret-123' } },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        status: 'INVALID_ARGUMENT',
        message: 'ListTasks "includeArtifacts" must be a boolean',
        details: [expect.objectContaining({ reason: 'INVALID_PARAMS' })],
      },
    });
  });

  it('maps google.rpc.Status errors back to typed A2A errors', async () => {
    await expect(client.getTask('missing-task')).rejects.toBeInstanceOf(
      TaskNotFoundError,
    );
    const response = await fetch(`${baseUrl}/a2a/tasks/missing-task`, {
      headers: {
        Accept: 'application/a2a+json',
        'A2A-Version': '1.0',
        'x-api-key': 'secret-123',
      },
    });
    expect(response.status).toBe(404);
    const body = (await response.json()) as {
      error: { code: number; status: string; details: Array<{ reason: string }> };
    };
    expect(body.error.code).toBe(404);
    expect(body.error.status).toBe('NOT_FOUND');
    expect(body.error.details[0]?.reason).toBe('TASK_NOT_FOUND');
  });

  it('drains unexpected bodies on non-POST REST requests', async () => {
    const request = Readable.from(['unexpected body']) as IncomingMessage;
    request.method = 'GET';
    request.url = '/a2a/tasks/missing-task';
    request.headers = { 'x-api-key': 'secret-123' };
    const resume = vi.spyOn(request, 'resume');
    const response = {
      setHeader() {
        return this;
      },
      writeHead() {
        return this;
      },
      end() {
        return this;
      },
    } as unknown as ServerResponse;

    await requestListener(request, response);

    expect(resume).toHaveBeenCalledOnce();
  });

  it('returns a structured error for invalid resource percent-encoding', async () => {
    const response = await fetch(`${baseUrl}/a2a/tasks/%E0`, {
      headers: {
        Accept: 'application/a2a+json',
        'A2A-Version': '1.0',
      },
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        status: 'INVALID_ARGUMENT',
        message: 'Invalid percent-encoding in resource ID',
        details: [expect.objectContaining({ reason: 'INVALID_PARAMS' })],
      },
    });
  });

  it('rejects malformed REST JSON with google.rpc.Status', async () => {
    const response = await fetch(`${baseUrl}/a2a/message:send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/a2a+json',
        'A2A-Version': '1.0',
      },
      body: '{',
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 400,
        status: 'INVALID_ARGUMENT',
        message: 'Invalid JSON request body',
        details: [expect.objectContaining({ reason: 'JSON_PARSE' })],
      },
    });
  });

  it('validates Content-Type for an empty REST POST', async () => {
    const response = await fetch(`${baseUrl}/a2a/message:send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'A2A-Version': '1.0',
      },
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        status: 'INVALID_ARGUMENT',
        message:
          'HTTP+JSON requests require application/a2a+json or application/json',
        details: [
          expect.objectContaining({ reason: 'CONTENT_TYPE_NOT_SUPPORTED' }),
        ],
      },
    });
  });

  it('validates Content-Type before parsing a non-empty REST body', async () => {
    const response = await fetch(`${baseUrl}/a2a/message:send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/plain',
        'A2A-Version': '1.0',
      },
      body: '{',
    });
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        status: 'INVALID_ARGUMENT',
        message:
          'HTTP+JSON requests require application/a2a+json or application/json',
        details: [
          expect.objectContaining({ reason: 'CONTENT_TYPE_NOT_SUPPORTED' }),
        ],
      },
    });
  });

  it('rejects REST request bodies larger than 1 MiB', async () => {
    const response = await fetch(`${baseUrl}/a2a/message:send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/a2a+json',
        'A2A-Version': '1.0',
      },
      body: JSON.stringify({ padding: 'x'.repeat(1024 * 1024) }),
    });
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: {
        code: 413,
        status: 'RESOURCE_EXHAUSTED',
        details: [
          expect.objectContaining({ reason: 'REQUEST_BODY_TOO_LARGE' }),
        ],
      },
    });
  });

  it('enforces the REST request-body limit without Content-Length', async () => {
    const chunk = new TextEncoder().encode('x'.repeat(600 * 1024));
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk);
        controller.close();
      },
    });
    const response = await fetch(`${baseUrl}/a2a/message:send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/a2a+json',
        'A2A-Version': '1.0',
      },
      body,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    expect(response.status).toBe(413);
  });

  it.each([
    {
      name: 'request stream errors',
      fail: (stream: Readable) => stream.destroy(new Error('request read failed')),
      message: 'request read failed',
    },
    {
      name: 'aborted uploads',
      fail: (stream: Readable) => {
        stream.emit('aborted');
        stream.push(null);
      },
      message: 'Request aborted while reading body',
    },
  ])('maps REST $name to a structured response', async ({ fail, message }) => {
    const request = new Readable({
      read() {
        fail(this);
      },
    }) as unknown as IncomingMessage;
    request.method = 'POST';
    request.url = '/a2a/message:send';
    request.headers = { 'content-type': 'application/a2a+json' };

    let status = 0;
    let responseBody = '';
    const response = {
      setHeader() {
        return this;
      },
      writeHead(statusCode: number) {
        status = statusCode;
        return this;
      },
      end(body: unknown) {
        responseBody = String(body);
        return this;
      },
    } as unknown as ServerResponse;

    await requestListener(request, response);

    expect(status).toBe(500);
    expect(JSON.parse(responseBody)).toMatchObject({
      error: {
        code: 500,
        status: 'INTERNAL',
        message,
      },
    });
  });

  it('round-trips push-notification configuration CRUD over REST', async () => {
    const task = await client.sendMessage(message('push config'));
    const config = {
      taskId: task.id,
      pushNotificationConfig: {
        id: 'cfg-1',
        url: 'https://client.example.com/hooks/a2a',
        authentication: { schemes: ['Bearer'], credentials: 'secret' },
      },
    };
    await expect(client.createTaskPushNotificationConfig(config)).resolves.toEqual(config);
    await expect(
      client.getTaskPushNotificationConfig(task.id, 'cfg-1'),
    ).resolves.toEqual(config);
    await expect(client.listTaskPushNotificationConfigs(task.id)).resolves.toEqual([
      config,
    ]);
    await client.deleteTaskPushNotificationConfig(task.id, 'cfg-1');
    await expect(
      client.getTaskPushNotificationConfig(task.id, 'cfg-1'),
    ).rejects.toBeInstanceOf(TaskNotFoundError);
  });

  it('retrieves the authenticated extended AgentCard over REST', async () => {
    await expect(client.getExtendedAgentCard()).resolves.toMatchObject({
      description: 'Authenticated REST agent',
    });
  });

  it('fails closed when a card advertises no installed transport', () => {
    const card: AgentCardV10 = {
      name: 'grpc-only',
      description: 'grpc-only',
      version: '1.0.0',
      supportedInterfaces: [
        {
          url: 'https://example.com/grpc',
          protocolBinding: 'GRPC',
          protocolVersion: '1.0',
        },
      ],
      capabilities: {},
      skills: [],
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
    };
    expect(() => selectAgentInterface(card, '1.0')).toThrow(
      'no supported A2A transport interface',
    );
  });
});

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}
