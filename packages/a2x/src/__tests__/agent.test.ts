import { describe, it, expect } from 'vitest';
import { LlmAgent } from '../agent/llm-agent.js';
import { BaseAgent } from '../agent/base-agent.js';

describe('Layer 2: Agent', () => {
  describe('LlmAgent', () => {
    it('should create with required options', () => {
      const agent = new LlmAgent({
        name: 'test-agent',
        model: 'gpt-4',
        instruction: 'You are a helpful assistant.',
      });

      expect(agent.name).toBe('test-agent');
      expect(agent.modelName).toBe('gpt-4');
      expect(agent.tools).toEqual([]);
    });

    it('should accept description', () => {
      const agent = new LlmAgent({
        name: 'test-agent',
        model: 'gpt-4',
        description: 'A test agent',
        instruction: 'You are a helpful assistant.',
      });

      expect(agent.description).toBe('A test agent');
    });

    it('should be an instance of BaseAgent', () => {
      const agent = new LlmAgent({
        name: 'test-agent',
        model: 'gpt-4',
        instruction: 'You are a helpful assistant.',
      });

      expect(agent).toBeInstanceOf(BaseAgent);
    });

    it('should resolve function instruction', async () => {
      const agent = new LlmAgent({
        name: 'test-agent',
        model: 'gpt-4',
        instruction: async () => 'Dynamic instruction',
      });

      const instruction = await agent.getInstruction({
        session: {
          id: 's1',
          appName: 'test',
          state: {},
          events: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        state: {},
        agentName: 'test-agent',
      });

      expect(instruction).toBe('Dynamic instruction');
    });

    it('modelName should return "custom" for LlmProvider', () => {
      const agent = new LlmAgent({
        name: 'test-agent',
        model: {
          generateContent: async () => ({
            content: [],
            finishReason: 'stop',
          }),
        },
        instruction: 'test',
      });

      expect(agent.modelName).toBe('custom');
    });
  });
});
