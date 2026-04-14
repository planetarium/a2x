import { describe, it, expect, vi } from 'vitest';
import { A2XAgent } from '../a2x/a2x-agent.js';
import { AgentExecutor, StreamingMode } from '../a2x/agent-executor.js';
import { InMemoryTaskStore } from '../a2x/task-store.js';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { LlmAgent } from '../agent/llm-agent.js';
import { BaseLlmProvider } from '../provider/base.js';
import { ApiKeyAuthorization } from '../security/api-key.js';
import { HttpBearerAuthorization } from '../security/http-bearer.js';
import { OAuth2DeviceCodeAuthorization } from '../security/oauth2-device-code.js';
import type { AgentCardV03, AgentCardV10 } from '../types/agent-card.js';

// Ensure mappers are registered
import '../a2x/index.js';

const mockProvider = new (class extends BaseLlmProvider {
  readonly name = 'mock';
  constructor() { super({ model: 'gpt-4' }); }
  async generateContent() {
    return { content: [], finishReason: 'stop' };
  }
})();

function createA2XAgent(
  agentOpts?: { name?: string; description?: string; instruction?: string },
  streamingMode: StreamingMode = StreamingMode.SSE,
) {
  const agent = new LlmAgent({
    name: agentOpts?.name ?? 'my-agent',
    provider: mockProvider,
    description: agentOpts?.description ?? 'A test agent',
    instruction: agentOpts?.instruction ?? 'You are a helpful assistant.',
  });

  const runner = new InMemoryRunner({ agent, appName: 'test' });
  const executor = new AgentExecutor({
    runner,
    runConfig: { streamingMode },
  });
  const taskStore = new InMemoryTaskStore();

  return new A2XAgent({ taskStore, executor });
}

describe('Layer 3: A2XAgent', () => {
  describe('Constructor - options object', () => {
    it('should construct with required options', () => {
      const a2x = createA2XAgent();
      expect(a2x).toBeDefined();
      expect(a2x.protocolVersion).toBe('1.0');
    });

    it('should accept protocolVersion 0.3', () => {
      const agent = new LlmAgent({
        name: 'test',
        provider: mockProvider,
        description: 'test',
        instruction: 'test',
      });
      const runner = new InMemoryRunner({ agent, appName: 'test' });
      const executor = new AgentExecutor({
        runner,
        runConfig: { streamingMode: StreamingMode.NONE },
      });
      const taskStore = new InMemoryTaskStore();

      const a2x = new A2XAgent({ taskStore, executor, protocolVersion: '0.3' });
      expect(a2x.protocolVersion).toBe('0.3');
    });

    it('should accept protocolVersion 1.0', () => {
      const agent = new LlmAgent({
        name: 'test',
        provider: mockProvider,
        description: 'test',
        instruction: 'test',
      });
      const runner = new InMemoryRunner({ agent, appName: 'test' });
      const executor = new AgentExecutor({
        runner,
        runConfig: { streamingMode: StreamingMode.NONE },
      });
      const taskStore = new InMemoryTaskStore();

      const a2x = new A2XAgent({ taskStore, executor, protocolVersion: '1.0' });
      expect(a2x.protocolVersion).toBe('1.0');
    });

    it('should default protocolVersion to 1.0 when omitted', () => {
      const a2x = createA2XAgent();
      expect(a2x.protocolVersion).toBe('1.0');
    });

    it('should throw for unsupported protocolVersion', () => {
      const agent = new LlmAgent({
        name: 'test',
        provider: mockProvider,
        description: 'test',
        instruction: 'test',
      });
      const runner = new InMemoryRunner({ agent, appName: 'test' });
      const executor = new AgentExecutor({
        runner,
        runConfig: { streamingMode: StreamingMode.NONE },
      });
      const taskStore = new InMemoryTaskStore();

      expect(
        () => new A2XAgent({ taskStore, executor, protocolVersion: '2.0' as '0.3' }),
      ).toThrow("unsupported protocolVersion '2.0'");
    });

    it('should throw when taskStore is missing', () => {
      expect(
        () => new A2XAgent({ taskStore: null as never, executor: {} as never }),
      ).toThrow('taskStore is required');
    });

    it('should throw when executor is missing', () => {
      expect(
        () => new A2XAgent({ taskStore: {} as never, executor: null as never }),
      ).toThrow('executor is required');
    });
  });

  describe('Builder methods', () => {
    it('should chain builder methods', () => {
      const a2x = createA2XAgent();
      const result = a2x
        .setName('test')
        .setDescription('desc')
        .setVersion('2.0.0')
        .setDefaultUrl('https://example.com/a2a');

      expect(result).toBe(a2x);
    });

    it('should throw on empty defaultUrl', () => {
      const a2x = createA2XAgent();
      expect(() => a2x.setDefaultUrl('')).toThrow('url must not be empty');
    });

    it('should throw on missing interface fields', () => {
      const a2x = createA2XAgent();
      expect(() =>
        a2x.addInterface({ url: '', protocol: 'JSONRPC' }),
      ).toThrow('url and protocol are required');
    });
  });

  describe('getAgentCard - auto-extraction', () => {
    it('should auto-extract name from agent', () => {
      const a2x = createA2XAgent({ name: 'auto-name' });
      a2x.setDefaultUrl('https://example.com/a2a');

      const card = a2x.getAgentCard('1.0') as AgentCardV10;
      expect(card.name).toBe('auto-name');
    });

    it('should auto-extract description from agent', () => {
      const a2x = createA2XAgent({ description: 'Auto description' });
      a2x.setDefaultUrl('https://example.com/a2a');

      const card = a2x.getAgentCard('1.0') as AgentCardV10;
      expect(card.description).toBe('Auto description');
    });

    it('should auto-extract streaming capability', () => {
      const a2x = createA2XAgent(undefined, StreamingMode.SSE);
      a2x.setDefaultUrl('https://example.com/a2a');

      const card = a2x.getAgentCard('1.0') as AgentCardV10;
      expect(card.capabilities.streaming).toBe(true);
    });

    it('should prefer explicit overrides over auto-extraction', () => {
      const a2x = createA2XAgent({ name: 'auto' });
      a2x
        .setName('override')
        .setDescription('Override desc')
        .setDefaultUrl('https://example.com/a2a');

      const card = a2x.getAgentCard('1.0') as AgentCardV10;
      expect(card.name).toBe('override');
      expect(card.description).toBe('Override desc');
    });
  });

  describe('getAgentCard - v1.0', () => {
    it('should generate v1.0 AgentCard', () => {
      const a2x = createA2XAgent();
      a2x
        .setDefaultUrl('https://example.com/a2a')
        .setVersion('1.0.0')
        .addSkill({
          id: 'code-gen',
          name: 'Code Generation',
          description: 'Generates code',
          tags: ['code'],
        });

      const card = a2x.getAgentCard('1.0') as AgentCardV10;

      expect(card.name).toBe('my-agent');
      expect(card.description).toBe('A test agent');
      expect(card.version).toBe('1.0.0');
      expect(card.supportedInterfaces).toHaveLength(1);
      expect(card.supportedInterfaces[0]).toEqual({
        url: 'https://example.com/a2a',
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      });
      expect(card.skills).toHaveLength(1);
      expect(card.skills[0].id).toBe('code-gen');
    });

    it('should include additional interfaces', () => {
      const a2x = createA2XAgent();
      a2x
        .setDefaultUrl('https://example.com/a2a')
        .addInterface({
          url: 'https://example.com/grpc',
          protocol: 'GRPC',
          protocolVersion: '1.0',
        });

      const card = a2x.getAgentCard('1.0') as AgentCardV10;
      expect(card.supportedInterfaces).toHaveLength(2);
      expect(card.supportedInterfaces[1].protocolBinding).toBe('GRPC');
    });

    it('should include security schemes', () => {
      const a2x = createA2XAgent();
      a2x
        .setDefaultUrl('https://example.com/a2a')
        .addSecurityScheme(
          'bearer',
          new HttpBearerAuthorization({ scheme: 'bearer' }),
        )
        .addSecurityRequirement({ bearer: [] });

      const card = a2x.getAgentCard('1.0') as AgentCardV10;
      expect(card.securitySchemes).toBeDefined();
      expect(card.securitySchemes!['bearer']).toEqual({
        httpAuthSecurityScheme: { scheme: 'bearer' },
      });
      expect(card.securityRequirements).toEqual([{ bearer: [] }]);
    });
  });

  describe('getAgentCard - v0.3', () => {
    it('should generate v0.3 AgentCard', () => {
      const a2x = createA2XAgent();
      a2x
        .setDefaultUrl('https://example.com/a2a')
        .addSkill({
          id: 'code-gen',
          name: 'Code Generation',
          description: 'Generates code',
          tags: ['code'],
          securityRequirements: [{ api_key: [] }],
        })
        .addSecurityScheme(
          'api_key',
          new ApiKeyAuthorization({ in: 'header', name: 'X-API-Key' }),
        );

      const card = a2x.getAgentCard('0.3') as AgentCardV03;

      expect(card.name).toBe('my-agent');
      expect(card.url).toBe('https://example.com/a2a');
      expect(card.protocolVersion).toBe('0.3.0');
      expect(card.preferredTransport).toBe('JSONRPC');
      // v0.3 skill uses "security" not "securityRequirements"
      expect(card.skills[0].security).toEqual([{ api_key: [] }]);
    });

    it('should exclude DeviceCode scheme from v0.3 with warning', () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const a2x = createA2XAgent();
      a2x
        .setDefaultUrl('https://example.com/a2a')
        .addSecurityScheme(
          'device',
          new OAuth2DeviceCodeAuthorization({
            deviceAuthorizationUrl: 'https://auth.example.com/device',
            tokenUrl: 'https://auth.example.com/token',
            scopes: { read: 'Read' },
          }),
        );

      const card = a2x.getAgentCard('0.3') as AgentCardV03;
      expect(card.securitySchemes).toBeUndefined();
      expect(warnSpy).toHaveBeenCalled();
      warnSpy.mockRestore();
    });
  });

  describe('getAgentCard - default version from config', () => {
    it('should use configured protocolVersion when no argument is given', () => {
      const agent = new LlmAgent({
        name: 'test',
        provider: mockProvider,
        description: 'test desc',
        instruction: 'test',
      });
      const runner = new InMemoryRunner({ agent, appName: 'test' });
      const executor = new AgentExecutor({
        runner,
        runConfig: { streamingMode: StreamingMode.NONE },
      });
      const taskStore = new InMemoryTaskStore();

      const a2x = new A2XAgent({ taskStore, executor, protocolVersion: '0.3' });
      a2x.setDefaultUrl('https://example.com/a2a');

      const card = a2x.getAgentCard() as AgentCardV03;
      expect(card.protocolVersion).toBe('0.3.0');
    });

    it('should allow explicit version to override configured protocolVersion', () => {
      const agent = new LlmAgent({
        name: 'test',
        provider: mockProvider,
        description: 'test desc',
        instruction: 'test',
      });
      const runner = new InMemoryRunner({ agent, appName: 'test' });
      const executor = new AgentExecutor({
        runner,
        runConfig: { streamingMode: StreamingMode.NONE },
      });
      const taskStore = new InMemoryTaskStore();

      const a2x = new A2XAgent({ taskStore, executor, protocolVersion: '0.3' });
      a2x.setDefaultUrl('https://example.com/a2a');

      const card = a2x.getAgentCard('1.0') as AgentCardV10;
      expect(card.supportedInterfaces).toBeDefined();
    });
  });

  describe('getAgentCard - validation', () => {
    it('should throw when name is missing', () => {
      const agent = new LlmAgent({
        name: '',
        provider: mockProvider,
        instruction: 'test',
      });

      const runner = new InMemoryRunner({ agent, appName: 'test' });
      const executor = new AgentExecutor({
        runner,
        runConfig: { streamingMode: StreamingMode.NONE },
      });
      const a2x = new A2XAgent({ taskStore: new InMemoryTaskStore(), executor });

      expect(() => a2x.getAgentCard()).toThrow('name is required');
    });

    it('should throw when description is missing and cannot be auto-extracted', () => {
      const agent = new LlmAgent({
        name: 'test',
        provider: mockProvider,
        instruction: '',
      });

      const runner = new InMemoryRunner({ agent, appName: 'test' });
      const executor = new AgentExecutor({
        runner,
        runConfig: { streamingMode: StreamingMode.NONE },
      });
      const a2x = new A2XAgent({ taskStore: new InMemoryTaskStore(), executor });

      expect(() => a2x.getAgentCard()).toThrow('description is required');
    });

    it('should throw when security requirement references unregistered scheme', () => {
      const a2x = createA2XAgent();
      a2x
        .setDefaultUrl('https://example.com/a2a')
        .addSecurityRequirement({ nonexistent: [] });

      expect(() => a2x.getAgentCard()).toThrow(
        "references unregistered scheme 'nonexistent'",
      );
    });
  });

  describe('getAgentCard - caching', () => {
    it('should cache and invalidate on builder method call', () => {
      const a2x = createA2XAgent();
      a2x.setDefaultUrl('https://example.com/a2a');

      const card1 = a2x.getAgentCard('1.0');
      const card2 = a2x.getAgentCard('1.0');
      expect(card1).toBe(card2); // Same reference (cached)

      a2x.setVersion('2.0.0');
      const card3 = a2x.getAgentCard('1.0');
      expect(card3).not.toBe(card1); // New object (cache invalidated)
      expect((card3 as AgentCardV10).version).toBe('2.0.0');
    });
  });
});
