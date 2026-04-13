import { describe, it, expect } from 'vitest';
import { InMemoryRunner } from '../runner/in-memory-runner.js';
import { InMemorySessionService } from '../runner/in-memory-session.js';
import { LlmAgent } from '../agent/llm-agent.js';

describe('Layer 2: Runner & Session', () => {
  describe('InMemorySessionService', () => {
    it('should create and retrieve sessions', async () => {
      const service = new InMemorySessionService();
      const session = await service.createSession('test-app', 'user-1');

      expect(session.id).toBeDefined();
      expect(session.appName).toBe('test-app');
      expect(session.userId).toBe('user-1');
      expect(session.state).toEqual({});
      expect(session.events).toEqual([]);

      const retrieved = await service.getSession('test-app', session.id);
      expect(retrieved).toEqual(session);
    });

    it('should return null for non-existent session', async () => {
      const service = new InMemorySessionService();
      const result = await service.getSession('test-app', 'non-existent');
      expect(result).toBeNull();
    });

    it('should delete sessions', async () => {
      const service = new InMemorySessionService();
      const session = await service.createSession('test-app');

      await service.deleteSession('test-app', session.id);
      const result = await service.getSession('test-app', session.id);
      expect(result).toBeNull();
    });
  });

  describe('InMemoryRunner', () => {
    it('should create with agent and appName', () => {
      const agent = new LlmAgent({
        name: 'test-agent',
        model: 'gpt-4',
        instruction: 'You are a helpful assistant.',
      });

      const runner = new InMemoryRunner({
        agent,
        appName: 'test-app',
      });

      expect(runner.agent).toBe(agent);
      expect(runner.appName).toBe('test-app');
    });

    it('should create sessions', async () => {
      const agent = new LlmAgent({
        name: 'test-agent',
        model: 'gpt-4',
        instruction: 'You are a helpful assistant.',
      });

      const runner = new InMemoryRunner({
        agent,
        appName: 'test-app',
      });

      const session = await runner.createSession('user-1');
      expect(session.appName).toBe('test-app');
      expect(session.userId).toBe('user-1');
    });

    it('should run agent and yield events', async () => {
      const agent = new LlmAgent({
        name: 'test-agent',
        model: 'gpt-4',
        instruction: 'You are a helpful assistant.',
      });

      const runner = new InMemoryRunner({
        agent,
        appName: 'test-app',
      });

      const session = await runner.createSession();
      const events = [];

      for await (const event of runner.runAsync(session, {
        messageId: 'msg-1',
        role: 'user',
        parts: [{ text: 'Hello' }],
      })) {
        events.push(event);
      }

      expect(events.length).toBeGreaterThan(0);
      expect(events[events.length - 1].type).toBe('done');
    });
  });
});
