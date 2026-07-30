/**
 * Tests for the A2A v1.0 JSON-RPC binding surface (issue #193).
 *
 * Spec a2a-v1.0 §9.4 renames every JSON-RPC method (`SendMessage`,
 * `GetTask`, …), §3.2.6 renames the extension activation header to
 * `A2A-Extensions`, and §3.2.6 / §9.2 define the `A2A-Version` service
 * parameter with `VersionNotSupportedError` (-32009) for unsupported
 * versions. A `protocolVersion: '1.0'` server must accept all of these;
 * a `protocolVersion: '0.3'` server must stay strictly v0.3 for method
 * names.
 */
import { describe, expect, it } from 'vitest';
import { A2XServer } from '../a2x/a2x-agent.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { BaseAgent, type AgentEvent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';
import { InMemoryTaskStore } from '../a2x/task-store.js';
import { DefaultRequestHandler } from '../transport/request-handler.js';
import { X402_EXTENSION_URI } from '../x402/index.js';
import type { ProtocolVersion } from '../types/agent-card.js';
// Ensure response mappers are registered (side-effect import).
import '../a2x/index.js';

class EchoAgent extends BaseAgent {
  /** The `ctx.message` values observed by the agent, in call order. */
  readonly seenMessages: Array<InvocationContext['message']> = [];

  constructor() {
    super({ name: 'echo', description: 'echo' });
  }
  async *run(ctx: InvocationContext): AsyncGenerator<AgentEvent> {
    this.seenMessages.push(ctx.message);
    yield { type: 'text', text: 'hi', role: 'agent' };
    yield { type: 'done' };
  }
}

function buildServer(
  protocolVersion: ProtocolVersion,
  options?: { requiredExtension?: string; agent?: EchoAgent },
): A2XServer {
  const agent = options?.agent ?? new EchoAgent();
  const runner = new InMemoryRunner({ agent, appName: 'test' });
  const executor = new AgentExecutor({
    runner,
    runConfig: { streamingMode: StreamingMode.SSE },
  });
  const a2x = new A2XServer({
    taskStore: new InMemoryTaskStore(),
    executor,
    protocolVersion,
  })
    .setName('x')
    .setDescription('x')
    .setDefaultUrl('https://example.com/a2a');
  if (options?.requiredExtension) {
    a2x.addExtension({ uri: options.requiredExtension, required: true });
  }
  return a2x;
}

function sendBody(method: string, role = 'user') {
  return {
    jsonrpc: '2.0',
    id: 1,
    method,
    params: {
      message: {
        messageId: 'm1',
        role,
        parts: [{ text: 'hi' }],
      },
    },
  };
}

type ErrorResult = { error?: { code: number; message: string } };
type TaskResult = { result?: { id: string; status: { state: string } } };

describe('v1.0 JSON-RPC method names (spec a2a-v1.0 §9.4)', () => {
  it('dispatches SendMessage on a 1.0 server', async () => {
    const handler = new DefaultRequestHandler(buildServer('1.0'));
    const result = (await handler.handle(sendBody('SendMessage'), {
      headers: {},
    })) as ErrorResult & TaskResult;
    expect(result.error).toBeUndefined();
    expect(result.result!.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('dispatches GetTask on a 1.0 server', async () => {
    const handler = new DefaultRequestHandler(buildServer('1.0'));
    const sent = (await handler.handle(sendBody('SendMessage'), {
      headers: {},
    })) as TaskResult;
    const result = (await handler.handle(
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'GetTask',
        params: { id: sent.result!.id },
      },
      { headers: {} },
    )) as ErrorResult & TaskResult;
    expect(result.error).toBeUndefined();
    expect(result.result!.id).toBe(sent.result!.id);
  });

  it('dispatches SendStreamingMessage as a stream on a 1.0 server', async () => {
    const handler = new DefaultRequestHandler(buildServer('1.0'));
    const result = await handler.handle(sendBody('SendStreamingMessage'), {
      headers: {},
    });
    expect(
      typeof result === 'object' && result !== null && Symbol.asyncIterator in result,
    ).toBe(true);
    const frames: unknown[] = [];
    for await (const frame of result as AsyncGenerator<unknown>) {
      frames.push(frame);
    }
    expect(frames.length).toBeGreaterThan(0);
  });

  it('routes GetExtendedAgentCard to the extended-card path on a 1.0 server', async () => {
    const handler = new DefaultRequestHandler(buildServer('1.0'));
    const result = (await handler.handle(
      { jsonrpc: '2.0', id: 3, method: 'GetExtendedAgentCard' },
      { headers: {} },
    )) as ErrorResult;
    // No provider configured → -32007, which proves the alias reached the
    // extended-card special case instead of falling through to -32601.
    expect(result.error!.code).toBe(-32007);
  });

  it('routes CreateTaskPushNotificationConfig past method dispatch on a 1.0 server', async () => {
    const handler = new DefaultRequestHandler(buildServer('1.0'));
    const result = (await handler.handle(
      {
        jsonrpc: '2.0',
        id: 4,
        method: 'CreateTaskPushNotificationConfig',
        params: { taskId: 't-missing', url: 'https://example.com/hook' },
      },
      { headers: {} },
    )) as ErrorResult;
    // No push config store configured → -32003, not -32601.
    expect(result.error!.code).toBe(-32003);
  });

  it('still accepts v0.3 method names on a 1.0 server (legacy compat)', async () => {
    const handler = new DefaultRequestHandler(buildServer('1.0'));
    const result = (await handler.handle(sendBody('message/send'), {
      headers: {},
    })) as ErrorResult & TaskResult;
    expect(result.error).toBeUndefined();
    expect(result.result!.status.state).toBe('TASK_STATE_COMPLETED');
  });

  it('rejects v1.0 method names on a 0.3 server with -32601', async () => {
    const handler = new DefaultRequestHandler(buildServer('0.3'));
    const result = (await handler.handle(sendBody('SendMessage'), {
      headers: {},
    })) as ErrorResult;
    expect(result.error!.code).toBe(-32601);
  });
});

describe('A2A-Extensions header (spec a2a-v1.0 §3.2.6)', () => {
  it('activates a required extension via A2A-Extensions on a 1.0 server', async () => {
    const handler = new DefaultRequestHandler(
      buildServer('1.0', { requiredExtension: X402_EXTENSION_URI }),
    );
    const result = (await handler.handle(sendBody('SendMessage'), {
      headers: { 'a2a-extensions': X402_EXTENSION_URI },
    })) as ErrorResult & TaskResult;
    expect(result.error).toBeUndefined();
    expect(result.result).toBeDefined();
  });

  it('still accepts the legacy X-A2A-Extensions spelling on a 1.0 server', async () => {
    const handler = new DefaultRequestHandler(
      buildServer('1.0', { requiredExtension: X402_EXTENSION_URI }),
    );
    const result = (await handler.handle(sendBody('SendMessage'), {
      headers: { 'x-a2a-extensions': X402_EXTENSION_URI },
    })) as ErrorResult & TaskResult;
    expect(result.error).toBeUndefined();
  });

  it('accepts A2A-Extensions on a 0.3 server too', async () => {
    const handler = new DefaultRequestHandler(
      buildServer('0.3', { requiredExtension: X402_EXTENSION_URI }),
    );
    const result = (await handler.handle(sendBody('message/send'), {
      headers: { 'a2a-extensions': X402_EXTENSION_URI },
    })) as ErrorResult & TaskResult;
    expect(result.error).toBeUndefined();
  });

  it('names the v1.0 header in the rejection message on a 1.0 server', async () => {
    const handler = new DefaultRequestHandler(
      buildServer('1.0', { requiredExtension: X402_EXTENSION_URI }),
    );
    const result = (await handler.handle(sendBody('SendMessage'), {
      headers: {},
    })) as ErrorResult;
    expect(result.error!.code).toBe(-32600);
    expect(result.error!.message).toContain('A2A-Extensions');
    expect(result.error!.message).not.toContain('X-A2A-Extensions');
  });

  it('names the v0.3 header in the rejection message on a 0.3 server', async () => {
    const handler = new DefaultRequestHandler(
      buildServer('0.3', { requiredExtension: X402_EXTENSION_URI }),
    );
    const result = (await handler.handle(sendBody('message/send'), {
      headers: {},
    })) as ErrorResult;
    expect(result.error!.code).toBe(-32600);
    expect(result.error!.message).toContain('X-A2A-Extensions');
  });
});

describe('A2A-Version header (spec a2a-v1.0 §3.2.6 / §9.2)', () => {
  it('accepts a matching version pin on a 1.0 server', async () => {
    const handler = new DefaultRequestHandler(buildServer('1.0'));
    const result = (await handler.handle(sendBody('SendMessage'), {
      headers: { 'a2a-version': '1.0' },
    })) as ErrorResult & TaskResult;
    expect(result.error).toBeUndefined();
  });

  it('rejects a mismatching version pin on a 1.0 server with -32009', async () => {
    const handler = new DefaultRequestHandler(buildServer('1.0'));
    const result = (await handler.handle(sendBody('message/send'), {
      headers: { 'a2a-version': '0.3' },
    })) as ErrorResult;
    expect(result.error!.code).toBe(-32009);
    expect(result.error!.message).toContain('0.3');
  });

  it('rejects a mismatching version pin on a 0.3 server with -32009', async () => {
    const handler = new DefaultRequestHandler(buildServer('0.3'));
    const result = (await handler.handle(sendBody('message/send'), {
      headers: { 'A2A-Version': '1.0' },
    })) as ErrorResult;
    expect(result.error!.code).toBe(-32009);
  });

  it('accepts a matching version pin on a 0.3 server', async () => {
    const handler = new DefaultRequestHandler(buildServer('0.3'));
    const result = (await handler.handle(sendBody('message/send'), {
      headers: { 'a2a-version': '0.3' },
    })) as ErrorResult & TaskResult;
    expect(result.error).toBeUndefined();
  });

  it('matches on Major.Minor — accepts a patch-qualified pin like 0.3.0', async () => {
    const handler = new DefaultRequestHandler(buildServer('0.3'));
    const result = (await handler.handle(sendBody('message/send'), {
      headers: { 'a2a-version': '0.3.0' },
    })) as ErrorResult & TaskResult;
    expect(result.error).toBeUndefined();
  });

  it('matches on Major.Minor — accepts 1.0.2 on a 1.0 server', async () => {
    const handler = new DefaultRequestHandler(buildServer('1.0'));
    const result = (await handler.handle(sendBody('SendMessage'), {
      headers: { 'a2a-version': '1.0.2' },
    })) as ErrorResult & TaskResult;
    expect(result.error).toBeUndefined();
  });

  it('rejects a non-numeric version pin with -32009', async () => {
    const handler = new DefaultRequestHandler(buildServer('1.0'));
    const result = (await handler.handle(sendBody('SendMessage'), {
      headers: { 'a2a-version': 'not-a-version' },
    })) as ErrorResult;
    expect(result.error!.code).toBe(-32009);
  });

  it('serves the configured version when the header is absent', async () => {
    const handler = new DefaultRequestHandler(buildServer('1.0'));
    const result = (await handler.handle(sendBody('message/send'), {
      headers: {},
    })) as ErrorResult & TaskResult;
    expect(result.error).toBeUndefined();
    expect(result.result!.status.state).toBe('TASK_STATE_COMPLETED');
  });
});

describe('inbound v1.0 role normalization', () => {
  it('normalizes ROLE_USER to the internal role before agent code sees it', async () => {
    const agent = new EchoAgent();
    const handler = new DefaultRequestHandler(buildServer('1.0', { agent }));
    const result = (await handler.handle(sendBody('SendMessage', 'ROLE_USER'), {
      headers: {},
    })) as ErrorResult;
    expect(result.error).toBeUndefined();
    expect(agent.seenMessages).toHaveLength(1);
    expect(agent.seenMessages[0]!.role).toBe('user');
  });

  it('leaves v0.3 roles untouched on a 0.3 server', async () => {
    const agent = new EchoAgent();
    const handler = new DefaultRequestHandler(buildServer('0.3', { agent }));
    const result = (await handler.handle(sendBody('message/send'), {
      headers: {},
    })) as ErrorResult;
    expect(result.error).toBeUndefined();
    expect(agent.seenMessages[0]!.role).toBe('user');
  });
});
