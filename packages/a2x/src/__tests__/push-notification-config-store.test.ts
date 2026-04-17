import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryPushNotificationConfigStore } from '../a2x/push-notification-config-store.js';
import type { TaskPushNotificationConfig } from '../types/jsonrpc.js';

describe('InMemoryPushNotificationConfigStore', () => {
  let store: InMemoryPushNotificationConfigStore;

  beforeEach(() => {
    store = new InMemoryPushNotificationConfigStore();
  });

  const config: TaskPushNotificationConfig = {
    id: 'config-1',
    taskId: 'task-1',
    pushNotificationConfig: {
      id: 'config-1',
      url: 'https://example.com/webhook',
      token: 'tok-123',
    },
  };

  describe('set and get', () => {
    it('should store and retrieve a config', async () => {
      await store.set(config);
      const result = await store.get('task-1', 'config-1');
      expect(result).toEqual(config);
    });

    it('should return null for non-existent config', async () => {
      const result = await store.get('task-1', 'non-existent');
      expect(result).toBeNull();
    });
  });

  describe('delete', () => {
    it('should delete an existing config and return true', async () => {
      await store.set(config);
      const deleted = await store.delete('task-1', 'config-1');
      expect(deleted).toBe(true);

      const result = await store.get('task-1', 'config-1');
      expect(result).toBeNull();
    });

    it('should return false when deleting non-existent config', async () => {
      const deleted = await store.delete('task-1', 'non-existent');
      expect(deleted).toBe(false);
    });
  });

  describe('list', () => {
    it('should list all configs for a task', async () => {
      const config2: TaskPushNotificationConfig = {
        id: 'config-2',
        taskId: 'task-1',
        pushNotificationConfig: {
          id: 'config-2',
          url: 'https://example.com/webhook2',
        },
      };

      await store.set(config);
      await store.set(config2);
      const configs = await store.list('task-1');
      expect(configs).toHaveLength(2);
      expect(configs.map(c => c.id)).toContain('config-1');
      expect(configs.map(c => c.id)).toContain('config-2');
    });

    it('should return empty array for task with no configs', async () => {
      const configs = await store.list('no-task');
      expect(configs).toHaveLength(0);
    });
  });
});
