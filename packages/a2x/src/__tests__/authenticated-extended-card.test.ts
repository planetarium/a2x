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
import { A2A_METHODS } from '../types/jsonrpc.js';
import type { JSONRPCResponse, JSONRPCErrorResponse } from '../types/jsonrpc.js';
import { ApiKeyAuthorization } from '../security/api-key.js';
import type { RequestContext, AuthResult } from '../types/auth.js';
import type {
  A2XAgentState,
  AgentCardV03,
  AgentCardV10,
} from '../types/agent-card.js';

// Ensure mappers are registered
import '../a2x/index.js';

const mockProvider = new (class extends BaseLlmProvider {
  readonly name = 'mock';
  constructor() {
    super({ model: 'gpt-4' });
  }
  async generateContent() {
    return { content: [], finishReason: 'stop' };
  }
})();

interface HandlerBuildOptions {
  protocolVersion?: ProtocolVersion;
  withProvider?: (authResult: AuthResult) => Partial<A2XAgentState> | Promise<Partial<A2XAgentState>>;
  withAuth?: boolean;
}

function createHandler(options: HandlerBuildOptions = {}): DefaultRequestHandler {
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
  const a2xAgent = new A2XAgent({
    taskStore,
    executor,
    protocolVersion: options.protocolVersion,
  });
  a2xAgent.setDefaultUrl('https://example.com/a2a');

  if (options.withAuth) {
    a2xAgent
      .addSecurityScheme(
        'apiKey',
        new ApiKeyAuthorization({
          in: 'header',
          name: 'x-api-key',
          keys: ['secret-123'],
        }),
      )
      .addSecurityRequirement({ apiKey: [] });
  }

  if (options.withProvider) {
    a2xAgent.setAuthenticatedExtendedCardProvider(options.withProvider);
  }

  return new DefaultRequestHandler(a2xAgent);
}

function isAsyncGenerator(value: unknown): value is AsyncGenerator {
  return (
    value !== null &&
    typeof value === 'object' &&
    Symbol.asyncIterator in (value as object)
  );
}

const validContext: RequestContext = {
  headers: { 'x-api-key': 'secret-123' },
};

const extendedCardRequest = {
  jsonrpc: '2.0' as const,
  id: 1,
  method: A2A_METHODS.GET_EXTENDED_CARD,
};

describe('agent/getAuthenticatedExtendedCard', () => {
  it('method constant is spec-compliant', () => {
    expect(A2A_METHODS.GET_EXTENDED_CARD).toBe(
      'agent/getAuthenticatedExtendedCard',
    );
  });

  it('returns AuthenticatedExtendedCardNotConfiguredError when no provider is registered', async () => {
    const handler = createHandler({ withAuth: true });

    const response = await handler.handle(extendedCardRequest, validContext);

    expect(isAsyncGenerator(response)).toBe(false);
    const rpc = response as JSONRPCResponse;
    expect('error' in rpc).toBe(true);
    expect((rpc as JSONRPCErrorResponse).error.code).toBe(
      A2A_ERROR_CODES.AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED,
    );
  });

  it('returns InvalidRequest when the call is unauthenticated', async () => {
    const handler = createHandler({
      withAuth: true,
      withProvider: () => ({ description: 'Extended' }),
    });

    // Missing API key — auth fails. The extended-card method has no
    // task-shaped response, so the handler falls back to InvalidRequest
    // (-32600). Spec a2a-v0.3 / v1.0 reserve the auth-required TaskState
    // for task-creating methods only.
    const response = await handler.handle(extendedCardRequest, {
      headers: {},
    });

    expect(isAsyncGenerator(response)).toBe(false);
    const rpc = response as JSONRPCResponse;
    expect('error' in rpc).toBe(true);
    expect((rpc as JSONRPCErrorResponse).error.code).toBe(
      A2A_ERROR_CODES.INVALID_REQUEST,
    );
  });

  it('returns InvalidRequest when no context is provided but provider is configured', async () => {
    // Provider configured but also requires auth. Without a context, the
    // pre-dispatch auth step is skipped, so the special-case branch trips
    // on missing authResult and raises InvalidRequest itself.
    const handler = createHandler({
      withAuth: true,
      withProvider: () => ({ description: 'Extended' }),
    });

    const response = await handler.handle(extendedCardRequest);

    expect(isAsyncGenerator(response)).toBe(false);
    const rpc = response as JSONRPCResponse;
    expect('error' in rpc).toBe(true);
    expect((rpc as JSONRPCErrorResponse).error.code).toBe(
      A2A_ERROR_CODES.INVALID_REQUEST,
    );
  });

  it('returns merged card (v0.3) with overlay description and skills', async () => {
    const extraSkill = {
      id: 'premium-skill',
      name: 'Premium Skill',
      description: 'Only for authenticated users',
      tags: ['premium'],
    };

    const handler = createHandler({
      protocolVersion: '0.3',
      withAuth: true,
      withProvider: () => ({
        description: 'Extended desc',
        skills: [extraSkill],
      }),
    });

    const response = await handler.handle(extendedCardRequest, validContext);

    expect(isAsyncGenerator(response)).toBe(false);
    const rpc = response as JSONRPCResponse;
    expect('result' in rpc).toBe(true);
    const card = (rpc as { result: unknown }).result as AgentCardV03;

    expect(card.protocolVersion).toBe('0.3.0');
    expect(card.description).toBe('Extended desc');
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe('premium-skill');
    expect(card.supportsAuthenticatedExtendedCard).toBe(true);
  });

  it('returns merged card (v1.0) with capability flag and overlay reflected', async () => {
    const extraSkill = {
      id: 'premium-skill',
      name: 'Premium Skill',
      description: 'Only for authenticated users',
      tags: ['premium'],
    };

    const handler = createHandler({
      protocolVersion: '1.0',
      withAuth: true,
      withProvider: () => ({
        description: 'Extended desc v1',
        skills: [extraSkill],
      }),
    });

    const response = await handler.handle(extendedCardRequest, validContext);

    expect(isAsyncGenerator(response)).toBe(false);
    const rpc = response as JSONRPCResponse;
    expect('result' in rpc).toBe(true);
    const card = (rpc as { result: unknown }).result as AgentCardV10;

    expect(card.description).toBe('Extended desc v1');
    expect(card.skills).toHaveLength(1);
    expect(card.skills[0].id).toBe('premium-skill');
    expect(card.capabilities.extendedAgentCard).toBe(true);
  });

  it('passes the resolved AuthResult to the provider', async () => {
    let captured: AuthResult | undefined;

    const handler = createHandler({
      withAuth: true,
      withProvider: (authResult) => {
        captured = authResult;
        return { description: 'Extended' };
      },
    });

    const response = await handler.handle(extendedCardRequest, validContext);

    expect(isAsyncGenerator(response)).toBe(false);
    const rpc = response as JSONRPCResponse;
    expect('result' in rpc).toBe(true);

    expect(captured).toBeDefined();
    expect(captured!.authenticated).toBe(true);
    expect(captured!.principal).toEqual({ apiKey: 'secret-123' });
  });
});
