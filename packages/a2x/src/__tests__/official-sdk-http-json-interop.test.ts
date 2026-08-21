import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Role as OfficialRole, TaskState as OfficialTaskState } from '@a2a-js/sdk';
import {
  AgentEvent as OfficialAgentEvent,
  DefaultRequestHandler as OfficialRequestHandler,
  InMemoryTaskStore as OfficialTaskStore,
} from '@a2a-js/sdk/server';
import {
  ClientFactory as OfficialClientFactory,
  RestTransportFactory as OfficialRestTransportFactory,
} from '@a2a-js/sdk/client';
import {
  UserBuilder,
  restHandler as officialRestHandler,
} from '@a2a-js/sdk/server/express';
import { BaseAgent } from '../agent/base-agent.js';
import type { AgentEvent } from '../agent/base-agent.js';
import { A2XClient } from '../client/a2x-client.js';
import { A2A_TRANSPORTS } from '../types/transport.js';
import { A2XServer } from '../a2x/a2x-agent.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { InMemoryTaskStore } from '../a2x/task-store.js';
import { DefaultRequestHandler } from '../transport/request-handler.js';
import { HttpJsonRequestHandler } from '../transport/http-json-handler.js';
import { createA2xRequestListener } from '../transport/to-a2x.js';
import '../a2x/index.js';

class A2xInteropAgent extends BaseAgent {
  constructor() {
    super({ name: 'a2x-interop', description: 'Official SDK interop agent' });
  }

  async *run(): AsyncGenerator<AgentEvent> {
    yield { type: 'text', text: 'hello from a2x', role: 'agent' };
    yield { type: 'done' };
  }
}

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map(closeServer));
});

describe('HTTP+JSON interoperability with the official JavaScript SDK', () => {
  it('serves unary and streaming calls from the official REST client', async () => {
    const agent = new A2xInteropAgent();
    const executor = new AgentExecutor({
      runner: new InMemoryRunner({ agent, appName: 'interop' }),
      runConfig: { streamingMode: StreamingMode.SSE },
    });
    const a2xServer = new A2XServer({
      taskStore: new InMemoryTaskStore(),
      executor,
      protocolVersion: '1.0',
    })
      .setDefaultUrl('http://127.0.0.1/a2a')
      .setDefaultTransport(A2A_TRANSPORTS.HTTP_JSON);
    const handler = new DefaultRequestHandler(a2xServer);
    const httpJsonHandler = new HttpJsonRequestHandler(handler, {
      basePath: '/a2a',
    });
    const server = createServer(
      createA2xRequestListener(handler, 'http://127.0.0.1', {
        httpJsonHandler,
        jsonRpcEnabled: false,
      }),
    );
    const baseUrl = await listen(server);
    a2xServer.setDefaultUrl(`${baseUrl}/a2a`);

    const factory = new OfficialClientFactory({
      transports: [new OfficialRestTransportFactory()],
      preferredTransports: ['HTTP+JSON'],
    });
    const client = await factory.createFromUrl(baseUrl);
    const request = {
      message: {
        messageId: crypto.randomUUID(),
        role: OfficialRole.ROLE_USER,
        parts: [{ text: 'official client unary' }],
      },
      configuration: { returnImmediately: false },
    };
    const result = await client.sendMessage(request);
    expect('status' in result ? result.status.state : undefined).toBe(
      OfficialTaskState.TASK_STATE_COMPLETED,
    );

    const events = [];
    for await (const event of client.sendMessageStream({
      ...request,
      message: { ...request.message, messageId: crypto.randomUUID() },
    })) {
      events.push(event);
    }
    expect(events.some((event) => event.payload?.$case === 'task')).toBe(true);
    expect(events.some((event) => event.payload?.$case === 'statusUpdate')).toBe(
      true,
    );
  });

  it('consumes unary and streaming calls from the official REST server', async () => {
    const app = express();
    app.use(express.json({ type: ['application/json', 'application/a2a+json'] }));
    const executor = {
      async execute(context, eventBus) {
        eventBus.publish(
          OfficialAgentEvent.task({
            id: context.taskId,
            contextId: context.contextId,
            status: { state: OfficialTaskState.TASK_STATE_WORKING },
          }),
        );
        eventBus.publish(
          OfficialAgentEvent.artifactUpdate({
            taskId: context.taskId,
            contextId: context.contextId,
            artifact: {
              artifactId: crypto.randomUUID(),
              parts: [{ text: 'hello from the official SDK' }],
            },
          }),
        );
        eventBus.publish(
          OfficialAgentEvent.statusUpdate({
            taskId: context.taskId,
            contextId: context.contextId,
            status: { state: OfficialTaskState.TASK_STATE_COMPLETED },
          }),
        );
        eventBus.finished();
      },
      async cancelTask(taskId, eventBus) {
        eventBus.publish(
          OfficialAgentEvent.statusUpdate({
            taskId,
            contextId: '',
            status: { state: OfficialTaskState.TASK_STATE_CANCELED },
          }),
        );
        eventBus.finished();
      },
    } satisfies import('@a2a-js/sdk/server').AgentExecutor;
    const card = {
      name: 'official-rest-agent',
      description: 'Official SDK REST interop test agent',
      version: '1.0.0',
      supportedInterfaces: [
        {
          url: 'http://127.0.0.1/a2a',
          protocolBinding: 'HTTP+JSON',
          protocolVersion: '1.0',
        },
      ],
      capabilities: { streaming: true },
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [],
    } satisfies import('@a2a-js/sdk').AgentCard;
    const handler = new OfficialRequestHandler(
      card,
      new OfficialTaskStore(),
      executor,
    );
    app.get('/.well-known/agent-card.json', async (_request, response) => {
      response.json(await handler.getAgentCard());
    });
    app.use(
      '/a2a',
      officialRestHandler({
        requestHandler: handler,
        userBuilder: UserBuilder.noAuthentication,
      }),
    );
    const server = createServer(app);
    const baseUrl = await listen(server);
    card.supportedInterfaces[0]!.url = `${baseUrl}/a2a`;

    const client = new A2XClient(baseUrl);
    const params = {
      message: {
        messageId: crypto.randomUUID(),
        role: 'user' as const,
        parts: [{ text: 'a2x client unary' }],
      },
    };
    const task = await client.sendMessage(params);
    expect(task.status.state).toBe('completed');

    const events = [];
    for await (const event of client.sendMessageStream({
      ...params,
      message: { ...params.message, messageId: crypto.randomUUID() },
    })) {
      events.push(event);
    }
    expect(events.some((event) => 'artifact' in event)).toBe(true);
    expect(events.at(-1)?.status.state).toBe('completed');
  });
});

async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function closeServer(server: Server): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
    server.closeAllConnections();
  });
}
