/**
 * Layer 3: PushNotificationConfigStore interface and InMemory implementation.
 */

import type { TaskPushNotificationConfig } from '../types/jsonrpc.js';

// ─── PushNotificationConfigStore Interface ───

export interface PushNotificationConfigStore {
  get(taskId: string, configId: string): Promise<TaskPushNotificationConfig | null>;
  set(config: TaskPushNotificationConfig): Promise<TaskPushNotificationConfig>;
  delete(taskId: string, configId: string): Promise<boolean>;
  list(taskId: string): Promise<TaskPushNotificationConfig[]>;
}

// ─── InMemoryPushNotificationConfigStore ───

export class InMemoryPushNotificationConfigStore implements PushNotificationConfigStore {
  /** Map<taskId, Map<configId, config>> */
  private readonly configs = new Map<string, Map<string, TaskPushNotificationConfig>>();

  async get(taskId: string, configId: string): Promise<TaskPushNotificationConfig | null> {
    return this.configs.get(taskId)?.get(configId) ?? null;
  }

  async set(config: TaskPushNotificationConfig): Promise<TaskPushNotificationConfig> {
    const configId = config.pushNotificationConfig.id;
    if (!configId) {
      throw new Error(
        'InMemoryPushNotificationConfigStore.set: pushNotificationConfig.id is required for indexing',
      );
    }
    let taskConfigs = this.configs.get(config.taskId);
    if (!taskConfigs) {
      taskConfigs = new Map();
      this.configs.set(config.taskId, taskConfigs);
    }
    taskConfigs.set(configId, config);
    return config;
  }

  async delete(taskId: string, configId: string): Promise<boolean> {
    const taskConfigs = this.configs.get(taskId);
    if (!taskConfigs) return false;
    const deleted = taskConfigs.delete(configId);
    if (taskConfigs.size === 0) {
      this.configs.delete(taskId);
    }
    return deleted;
  }

  async list(taskId: string): Promise<TaskPushNotificationConfig[]> {
    const taskConfigs = this.configs.get(taskId);
    if (!taskConfigs) return [];
    return Array.from(taskConfigs.values());
  }
}
