import { describe, it, expect, vi, afterEach } from 'vitest';
import { applyArtifactUpdate, InMemoryTaskStore } from '../a2x/task-store.js';
import { TaskState } from '../types/task.js';
import type { Artifact } from '../types/common.js';

describe('Layer 3: TaskStore', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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

  describe('InMemoryTaskStore TTL eviction', () => {
    it('should evict a terminal task after ttlMs has passed', async () => {
      const now = 1000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const store = new InMemoryTaskStore({ ttlMs: 5000 });
      const task = await store.createTask({});

      // Move to terminal state — starts TTL clock
      await store.updateTask(task.id, {
        status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
      });

      // Before TTL: still accessible
      vi.spyOn(Date, 'now').mockReturnValue(now + 4999);
      expect(await store.getTask(task.id)).not.toBeNull();

      // After TTL: evicted on access
      vi.spyOn(Date, 'now').mockReturnValue(now + 5000);
      expect(await store.getTask(task.id)).toBeNull();
    });

    it('should not evict non-terminal tasks regardless of time', async () => {
      const now = 1000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const store = new InMemoryTaskStore({ ttlMs: 1000 });
      const task = await store.createTask({});

      // Update to non-terminal state
      await store.updateTask(task.id, {
        status: { state: TaskState.WORKING, timestamp: new Date().toISOString() },
      });

      // Way past TTL, but task is non-terminal — should survive
      vi.spyOn(Date, 'now').mockReturnValue(now + 999999);
      expect(await store.getTask(task.id)).not.toBeNull();
    });

    it('should sweep expired tasks on createTask', async () => {
      const now = 1000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const store = new InMemoryTaskStore({ ttlMs: 5000 });

      const t1 = await store.createTask({});
      const t2 = await store.createTask({});
      await store.updateTask(t1.id, {
        status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
      });
      await store.updateTask(t2.id, {
        status: { state: TaskState.FAILED, timestamp: new Date().toISOString() },
      });

      expect(store.size).toBe(2);

      // Advance past TTL and create a new task — triggers sweep
      vi.spyOn(Date, 'now').mockReturnValue(now + 6000);
      await store.createTask({});

      // t1 and t2 should be swept, only the new task remains
      expect(store.size).toBe(1);
    });

    it('should work without options (no TTL, no maxSize)', async () => {
      const store = new InMemoryTaskStore();
      const task = await store.createTask({});
      await store.updateTask(task.id, {
        status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
      });

      // No eviction — task persists indefinitely
      expect(await store.getTask(task.id)).not.toBeNull();
      expect(store.size).toBe(1);
    });
  });

  describe('InMemoryTaskStore maxSize eviction', () => {
    it('should evict oldest terminal tasks when maxSize is exceeded', async () => {
      const now = 1000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const store = new InMemoryTaskStore({ maxSize: 3 });

      // Create 3 tasks and complete them in order
      const t1 = await store.createTask({});
      vi.spyOn(Date, 'now').mockReturnValue(now + 1);
      await store.updateTask(t1.id, {
        status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
      });

      vi.spyOn(Date, 'now').mockReturnValue(now + 2);
      const t2 = await store.createTask({});
      vi.spyOn(Date, 'now').mockReturnValue(now + 3);
      await store.updateTask(t2.id, {
        status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
      });

      vi.spyOn(Date, 'now').mockReturnValue(now + 4);
      const t3 = await store.createTask({});
      vi.spyOn(Date, 'now').mockReturnValue(now + 5);
      await store.updateTask(t3.id, {
        status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
      });

      expect(store.size).toBe(3);

      // Creating a 4th task should evict the oldest terminal task (t1)
      vi.spyOn(Date, 'now').mockReturnValue(now + 6);
      await store.createTask({});

      expect(store.size).toBe(3);
      expect(await store.getTask(t1.id)).toBeNull();
      expect(await store.getTask(t2.id)).not.toBeNull();
      expect(await store.getTask(t3.id)).not.toBeNull();
    });

    it('should not evict non-terminal tasks when at capacity', async () => {
      const store = new InMemoryTaskStore({ maxSize: 2 });

      // Create 2 tasks, keep both in non-terminal state
      const t1 = await store.createTask({});
      await store.updateTask(t1.id, {
        status: { state: TaskState.WORKING, timestamp: new Date().toISOString() },
      });
      const t2 = await store.createTask({});

      expect(store.size).toBe(2);

      // Creating a 3rd task — no terminal tasks to evict, size goes to 3
      await store.createTask({});
      expect(store.size).toBe(3);

      // Both original tasks should survive
      expect(await store.getTask(t1.id)).not.toBeNull();
      expect(await store.getTask(t2.id)).not.toBeNull();
    });

    it('should combine TTL and maxSize', async () => {
      const now = 1000000;
      vi.spyOn(Date, 'now').mockReturnValue(now);

      const store = new InMemoryTaskStore({ maxSize: 5, ttlMs: 3000 });

      // Create and complete 2 tasks
      const t1 = await store.createTask({});
      await store.updateTask(t1.id, {
        status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
      });
      const t2 = await store.createTask({});
      await store.updateTask(t2.id, {
        status: { state: TaskState.FAILED, timestamp: new Date().toISOString() },
      });

      // Advance past TTL and create new task — both expired tasks should be swept
      vi.spyOn(Date, 'now').mockReturnValue(now + 4000);
      await store.createTask({});

      expect(store.size).toBe(1);
      expect(await store.getTask(t1.id)).toBeNull();
      expect(await store.getTask(t2.id)).toBeNull();
    });
  });

  describe('InMemoryTaskStore snapshot isolation', () => {
    it('should hand out snapshots, not the stored task (issue #233)', async () => {
      const store = new InMemoryTaskStore();
      const created = await store.createTask({ metadata: { a: 1 } });

      // Mutating a returned task must not reach the store — otherwise a
      // handler can "persist" a transition by accident in memory and
      // silently lose it against a durable store.
      created.status = {
        state: TaskState.COMPLETED,
        timestamp: new Date().toISOString(),
      };
      created.artifacts = [{ artifactId: 'a-1', parts: [{ text: 'leaked' }] }];
      (created.metadata as Record<string, unknown>).a = 2;

      const stored = await store.getTask(created.id);
      expect(stored!.status.state).toBe(TaskState.SUBMITTED);
      expect(stored!.artifacts).toBeUndefined();
      expect(stored!.metadata).toEqual({ a: 1 });
    });

    it('should snapshot the task returned by getTask', async () => {
      const store = new InMemoryTaskStore();
      const created = await store.createTask({});
      await store.updateTask(created.id, {
        artifacts: [{ artifactId: 'a-1', parts: [{ text: 'hi' }] }],
      });

      const first = await store.getTask(created.id);
      first!.status = {
        state: TaskState.FAILED,
        timestamp: new Date().toISOString(),
      };
      first!.artifacts![0]!.parts.push({ text: 'leaked' });

      const second = await store.getTask(created.id);
      expect(second!.status.state).toBe(TaskState.SUBMITTED);
      expect(second!.artifacts![0]!.parts).toHaveLength(1);
    });

    it('should snapshot the task returned by updateTask', async () => {
      const store = new InMemoryTaskStore();
      const created = await store.createTask({});

      const updated = await store.updateTask(created.id, {
        status: { state: TaskState.WORKING, timestamp: new Date().toISOString() },
        artifacts: [{ artifactId: 'a-1', parts: [{ text: 'hi' }] }],
      });
      updated.artifacts![0]!.parts.push({ text: 'leaked' });

      const stored = await store.getTask(created.id);
      expect(stored!.artifacts![0]!.parts).toHaveLength(1);
    });

    it('should keep tasks usable when metadata cannot be structured-cloned', async () => {
      const store = new InMemoryTaskStore();
      const created = await store.createTask({
        metadata: { onDone: () => 'not cloneable' },
      });

      const stored = await store.getTask(created.id);
      expect(stored!.status.state).toBe(TaskState.SUBMITTED);
      expect(typeof stored!.metadata!.onDone).toBe('function');
    });
  });

  describe('applyArtifactUpdate', () => {
    const chunk = (text: string): Artifact => ({
      artifactId: 'a-text',
      parts: [{ text }],
    });

    it('appends parts to the artifact carrying the same id', () => {
      const result = applyArtifactUpdate([chunk('hello ')], {
        artifact: chunk('world'),
        append: true,
      });

      expect(result).toHaveLength(1);
      expect(result[0]!.parts).toEqual([{ text: 'hello ' }, { text: 'world' }]);
    });

    it('replaces the artifact when append is not set', () => {
      const result = applyArtifactUpdate([chunk('partial')], {
        artifact: chunk('final'),
      });

      expect(result).toHaveLength(1);
      expect(result[0]!.parts).toEqual([{ text: 'final' }]);
    });

    it('adds unknown artifact ids, including appends with no predecessor', () => {
      const result = applyArtifactUpdate([chunk('text')], {
        artifact: { artifactId: 'a-data', parts: [{ data: { ok: true } }] },
        append: true,
      });

      expect(result.map((a) => a.artifactId)).toEqual(['a-text', 'a-data']);
    });

    it('does not mutate the input list', () => {
      const artifacts = [chunk('hello ')];
      applyArtifactUpdate(artifacts, { artifact: chunk('world'), append: true });

      expect(artifacts[0]!.parts).toEqual([{ text: 'hello ' }]);
    });
  });
});
