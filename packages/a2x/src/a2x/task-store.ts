/**
 * Layer 3: TaskStore interface and InMemoryTaskStore implementation.
 */

import { randomUUID } from 'node:crypto';
import type { Artifact, Message } from '../types/common.js';
import type { Task, TaskStatus } from '../types/task.js';
import { TaskState, TERMINAL_STATES } from '../types/task.js';

// ─── TaskStore Types ───

export interface CreateTaskParams {
  contextId?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskUpdate {
  status?: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: Record<string, unknown>;
}

// ─── TaskStore Interface ───

export interface TaskStore {
  createTask(params: CreateTaskParams): Promise<Task>;
  getTask(taskId: string): Promise<Task | null>;
  updateTask(taskId: string, update: TaskUpdate): Promise<Task>;
  deleteTask(taskId: string): Promise<void>;
}

// ─── InMemoryTaskStore Options ───

export interface InMemoryTaskStoreOptions {
  /**
   * Maximum number of tasks to keep in memory.
   * When exceeded, the oldest terminal-state tasks are evicted first.
   * Defaults to unlimited (no cap).
   */
  maxSize?: number;

  /**
   * Time-to-live in milliseconds for tasks that reach a terminal state
   * (completed, failed, canceled, rejected). After this duration the task
   * is automatically removed on the next access or sweep.
   * Defaults to unlimited (no expiry).
   */
  ttlMs?: number;
}

// ─── InMemoryTaskStore ───

export class InMemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>();
  private readonly terminalTimestamps = new Map<string, number>();
  private readonly maxSize: number | undefined;
  private readonly ttlMs: number | undefined;

  constructor(options?: InMemoryTaskStoreOptions) {
    this.maxSize = options?.maxSize;
    this.ttlMs = options?.ttlMs;
  }

  async createTask(params: CreateTaskParams): Promise<Task> {
    this._evictExpired();
    this._evictIfOverCapacity();

    const taskId = randomUUID();
    const task: Task = {
      id: taskId,
      contextId: params.contextId ?? randomUUID(),
      status: {
        state: TaskState.SUBMITTED,
        timestamp: new Date().toISOString(),
      },
      metadata: params.metadata,
    };
    this.tasks.set(taskId, task);
    return task;
  }

  async getTask(taskId: string): Promise<Task | null> {
    this._evictIfExpired(taskId);
    return this.tasks.get(taskId) ?? null;
  }

  async updateTask(taskId: string, update: TaskUpdate): Promise<Task> {
    this._evictIfExpired(taskId);

    const task = this.tasks.get(taskId);
    if (!task) {
      throw new Error(`Task not found: ${taskId}`);
    }

    // Enforce state transition rules: terminal states cannot be changed
    if (update.status && TERMINAL_STATES.has(task.status.state)) {
      throw new Error(
        `Cannot update task in terminal state '${task.status.state}': ${taskId}`,
      );
    }

    if (update.status) {
      task.status = update.status;
    }
    if (update.artifacts) {
      task.artifacts = update.artifacts;
    }
    if (update.history) {
      task.history = update.history;
    }
    if (update.metadata) {
      task.metadata = { ...task.metadata, ...update.metadata };
    }

    // Track when a task enters a terminal state for TTL eviction
    if (update.status && TERMINAL_STATES.has(update.status.state)) {
      this.terminalTimestamps.set(taskId, Date.now());
    }

    this.tasks.set(taskId, task);
    return task;
  }

  async deleteTask(taskId: string): Promise<void> {
    this.tasks.delete(taskId);
    this.terminalTimestamps.delete(taskId);
  }

  /** Number of tasks currently stored. */
  get size(): number {
    return this.tasks.size;
  }

  // ─── Private: Eviction ───

  /** Remove a single task if it has expired. */
  private _evictIfExpired(taskId: string): void {
    if (this.ttlMs === undefined) return;
    const enteredAt = this.terminalTimestamps.get(taskId);
    if (enteredAt !== undefined && Date.now() - enteredAt >= this.ttlMs) {
      this.tasks.delete(taskId);
      this.terminalTimestamps.delete(taskId);
    }
  }

  /** Sweep all expired terminal tasks. */
  private _evictExpired(): void {
    if (this.ttlMs === undefined) return;
    const now = Date.now();
    for (const [taskId, enteredAt] of this.terminalTimestamps) {
      if (now - enteredAt >= this.ttlMs) {
        this.tasks.delete(taskId);
        this.terminalTimestamps.delete(taskId);
      }
    }
  }

  /** Evict oldest terminal tasks if over maxSize. */
  private _evictIfOverCapacity(): void {
    if (this.maxSize === undefined || this.tasks.size < this.maxSize) return;

    // Collect terminal tasks sorted by entry time (oldest first)
    const terminalEntries = [...this.terminalTimestamps.entries()]
      .sort((a, b) => a[1] - b[1]);

    for (const [taskId] of terminalEntries) {
      if (this.tasks.size < this.maxSize) break;
      this.tasks.delete(taskId);
      this.terminalTimestamps.delete(taskId);
    }
  }
}
