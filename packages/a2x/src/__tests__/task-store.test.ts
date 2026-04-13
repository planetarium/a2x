import { describe, it, expect } from 'vitest';
import { InMemoryTaskStore } from '../a2x/task-store.js';
import { TaskState, TERMINAL_STATES } from '../types/task.js';

describe('Layer 3: TaskStore', () => {
  describe('InMemoryTaskStore', () => {
    it('should create a task with submitted status', async () => {
      const store = new InMemoryTaskStore();
      const task = await store.createTask({});

      expect(task.id).toBeDefined();
      expect(task.contextId).toBeDefined();
      expect(task.status.state).toBe(TaskState.SUBMITTED);
      expect(task.status.timestamp).toBeDefined();
    });

    it('should create a task with custom contextId', async () => {
      const store = new InMemoryTaskStore();
      const task = await store.createTask({ contextId: 'ctx-1' });

      expect(task.contextId).toBe('ctx-1');
    });

    it('should get a task by id', async () => {
      const store = new InMemoryTaskStore();
      const created = await store.createTask({});
      const retrieved = await store.getTask(created.id);

      expect(retrieved).toEqual(created);
    });

    it('should return null for non-existent task', async () => {
      const store = new InMemoryTaskStore();
      const result = await store.getTask('non-existent');

      expect(result).toBeNull();
    });

    it('should update a task status', async () => {
      const store = new InMemoryTaskStore();
      const task = await store.createTask({});

      const updated = await store.updateTask(task.id, {
        status: { state: TaskState.WORKING, timestamp: new Date().toISOString() },
      });

      expect(updated.status.state).toBe(TaskState.WORKING);
    });

    it('should reject update for task in terminal state', async () => {
      const store = new InMemoryTaskStore();
      const task = await store.createTask({});

      await store.updateTask(task.id, {
        status: {
          state: TaskState.COMPLETED,
          timestamp: new Date().toISOString(),
        },
      });

      await expect(
        store.updateTask(task.id, {
          status: {
            state: TaskState.WORKING,
            timestamp: new Date().toISOString(),
          },
        }),
      ).rejects.toThrow('Cannot update task in terminal state');
    });

    it('should delete a task', async () => {
      const store = new InMemoryTaskStore();
      const task = await store.createTask({});

      await store.deleteTask(task.id);
      const result = await store.getTask(task.id);

      expect(result).toBeNull();
    });

    it('should merge metadata on update', async () => {
      const store = new InMemoryTaskStore();
      const task = await store.createTask({ metadata: { key1: 'val1' } });

      const updated = await store.updateTask(task.id, {
        metadata: { key2: 'val2' },
      });

      expect(updated.metadata).toEqual({ key1: 'val1', key2: 'val2' });
    });
  });
});
