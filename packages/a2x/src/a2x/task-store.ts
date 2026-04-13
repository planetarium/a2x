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

// ─── InMemoryTaskStore ───

export class InMemoryTaskStore implements TaskStore {
  private readonly tasks = new Map<string, Task>();

  async createTask(params: CreateTaskParams): Promise<Task> {
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
    return this.tasks.get(taskId) ?? null;
  }

  async updateTask(taskId: string, update: TaskUpdate): Promise<Task> {
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

    this.tasks.set(taskId, task);
    return task;
  }

  async deleteTask(taskId: string): Promise<void> {
    this.tasks.delete(taskId);
  }
}
