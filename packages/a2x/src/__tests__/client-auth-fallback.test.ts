import { describe, expect, it, vi } from 'vitest';

vi.mock('../client/auth-provider-context.js', async (importOriginal) => {
  const actual = await importOriginal<
    typeof import('../client/auth-provider-context.js')
  >();
  return {
    ...actual,
    authProviderInvocation: actual.createAuthProviderInvocationContext(null),
  };
});

import type { AgentCardV10 } from '../types/agent-card.js';
import { TaskState } from '../types/task.js';
import { A2XClient } from '../client/a2x-client.js';
import type { AuthScheme } from '../client/auth-scheme.js';

const CARD: AgentCardV10 = {
  name: 'Secure Agent',
  description: 'Carrier-less auth context tests',
  version: '1.0.0',
  supportedInterfaces: [
    {
      url: 'http://localhost:4000/a2a',
      protocolBinding: 'JSONRPC',
      protocolVersion: '1.0',
    },
  ],
  capabilities: { streaming: true },
  securitySchemes: {
    apiKey: {
      apiKeySecurityScheme: {
        location: 'header',
        name: 'x-api-key',
      },
    },
  },
  securityRequirements: [
    { schemes: { apiKey: { list: [] } } },
  ],
  skills: [],
  defaultInputModes: ['text/plain'],
  defaultOutputModes: ['text/plain'],
};

const COMPLETED_TASK = {
  id: 'task-1',
  contextId: 'ctx-1',
  status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
};

function response(result: unknown) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => Promise.resolve({ jsonrpc: '2.0', id: 1, result }),
    headers: new Headers({ 'content-type': 'application/json' }),
  };
}

describe('A2XClient carrier-less auth fallback', () => {
  it('rejects same-client provide re-entry after an async boundary', async () => {
    const mockFetch = vi.fn().mockResolvedValue(response(COMPLETED_TASK));
    let client!: A2XClient;
    client = new A2XClient(CARD, {
      fetch: mockFetch,
      authProvider: {
        async provide(requirements) {
          await Promise.resolve();
          await client.getTask('bootstrap');
          return [requirements[0]![0]!.setCredential('key')];
        },
      },
    });

    await expect(client.getTask('outer')).rejects.toThrow(
      'AuthProvider.provide() cannot call an authenticated operation on the same A2XClient',
    );
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('documents conservative rejection of an unrelated cold call', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const provide = vi.fn(async (requirements: AuthScheme[][]) => {
      await gate;
      return [requirements[0]![0]!.setCredential('key')];
    });
    const mockFetch = vi.fn().mockResolvedValue(response(COMPLETED_TASK));
    const client = new A2XClient(CARD, {
      fetch: mockFetch,
      authProvider: { provide },
    });

    const first = client.getTask('first');
    await vi.waitFor(() => expect(provide).toHaveBeenCalledTimes(1));
    await expect(client.getTask('unrelated')).rejects.toThrow(
      'AuthProvider.provide() cannot call an authenticated operation on the same A2XClient',
    );
    release();
    await expect(first).resolves.toMatchObject({ id: COMPLETED_TASK.id });

    expect(provide).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('still coalesces refreshes for calls started before refresh', async () => {
    const authRequiredTask = {
      id: 'task-auth',
      contextId: 'ctx-auth',
      status: {
        state: TaskState.AUTH_REQUIRED,
        timestamp: new Date().toISOString(),
      },
    };
    let fetchCount = 0;
    const mockFetch = vi.fn().mockImplementation(() => {
      fetchCount += 1;
      return Promise.resolve(response(
        fetchCount === 1 || fetchCount > 3 ? COMPLETED_TASK : authRequiredTask,
      ));
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const refresh = vi.fn(async (schemes: AuthScheme[]) => {
      await gate;
      schemes[0]!.setCredential('new-key');
      return schemes;
    });
    const client = new A2XClient(CARD, {
      fetch: mockFetch,
      authProvider: {
        async provide(requirements) {
          return [requirements[0]![0]!.setCredential('old-key')];
        },
        refresh,
      },
    });

    // Resolve initial authentication before isolating concurrent refresh.
    await client.getTask('warmup');

    const first = client.sendMessage({
      message: { role: 'user', parts: [{ text: 'first' }] },
    });
    const second = client.sendMessage({
      message: { role: 'user', parts: [{ text: 'second' }] },
    });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledTimes(5);
  });
});
