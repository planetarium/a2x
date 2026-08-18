/**
 * Layer 3: TaskStore interface and InMemoryTaskStore implementation.
 */

import { randomUUID } from 'node:crypto';
import type { Artifact, Message } from '../types/common.js';
import type { Task, TaskArtifactUpdateEvent, TaskStatus } from '../types/task.js';
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

/**
 * Persistence contract for tasks.
 *
 * Implementations MUST behave as if every method crossed a process
 * boundary: the standard Task containers handed out by `createTask()`,
 * `getTask()` and `updateTask()` are snapshots, and mutating one must not
 * change what a later `getTask()` returns. Callers therefore have to write
 * every task transition back through `updateTask()`. `InMemoryTaskStore`
 * returns defensive copies for exactly this reason — so code that
 * accidentally relies on object identity fails in-memory too, instead of
 * only against a durable (serializing) store. An update must be applied
 * atomically against the latest stored task so concurrent artifact, status,
 * and cancellation writes cannot overwrite one another. Non-serializable
 * exotic leaf values in user metadata may retain identity.
 */
export interface TaskStore {
  createTask(params: CreateTaskParams): Promise<Task>;
  getTask(taskId: string): Promise<Task | null>;
  updateTask(taskId: string, update: TaskUpdate): Promise<Task>;
  deleteTask(taskId: string): Promise<void>;
}

/**
 * Snapshot a task so callers cannot mutate stored state through the
 * returned reference.
 *
 * `structuredClone` mirrors what a durable store's serialize/deserialize
 * round trip does. Task metadata and part payloads are user-controlled
 * though, and may hold values it refuses to clone (such as functions).
 * The fallback recursively copies arrays, plain objects, maps, and sets
 * while retaining only non-cloneable exotic leaf values. Cloneable class
 * instances may be normalized to plain objects by `structuredClone`.
 */
export function cloneTask(task: Task): Task {
  try {
    return structuredClone(task);
  } catch {
    return cloneFallbackValue(task);
  }
}

function cloneFallbackValue<T>(
  value: T,
  seen = new WeakMap<object, unknown>(),
): T {
  if (value === null || typeof value !== 'object') return value;

  const source = value as object;
  const existing = seen.get(source);
  if (existing !== undefined) return existing as T;

  if (Array.isArray(value)) {
    const copy: unknown[] = [];
    seen.set(source, copy);
    for (const item of value) copy.push(cloneFallbackValue(item, seen));
    return copy as T;
  }

  if (value instanceof Map) {
    const copy = new Map<unknown, unknown>();
    seen.set(source, copy);
    for (const [key, item] of value) {
      copy.set(
        cloneFallbackValue(key, seen),
        cloneFallbackValue(item, seen),
      );
    }
    return copy as T;
  }

  if (value instanceof Set) {
    const copy = new Set<unknown>();
    seen.set(source, copy);
    for (const item of value) copy.add(cloneFallbackValue(item, seen));
    return copy as T;
  }

  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    try {
      return structuredClone(value);
    } catch {
      // Exotic values can be meaningful metadata. Preserve the leaf rather
      // than rejecting the whole task; every standard container leading to
      // it has already been isolated.
      return value;
    }
  }

  const copy = Object.create(prototype) as Record<PropertyKey, unknown>;
  seen.set(source, copy);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;
    if ('value' in descriptor) {
      descriptor.value = cloneFallbackValue(descriptor.value, seen);
    }
    Object.defineProperty(copy, key, descriptor);
  }
  return copy as T;
}

/**
 * Fold a streamed artifact update into an accumulating artifact list,
 * following spec a2a-v0.3 §TaskArtifactUpdateEvent: `append: true` adds
 * the event's parts to the artifact already carrying that `artifactId`,
 * anything else replaces (or appends) the artifact wholesale.
 *
 * Returns a new array; the input list is left untouched.
 */
export function applyArtifactUpdate(
  artifacts: readonly Artifact[],
  event: Pick<TaskArtifactUpdateEvent, 'artifact' | 'append'>,
): Artifact[] {
  const next = [...artifacts];
  const index = next.findIndex(
    (a) => a.artifactId === event.artifact.artifactId,
  );

  if (event.append && index >= 0) {
    const existing = next[index]!;
    next[index] = {
      ...existing,
      ...event.artifact,
      parts: [...existing.parts, ...event.artifact.parts],
    };
    return next;
  }

  if (index >= 0) {
    next[index] = event.artifact;
    return next;
  }

  next.push(event.artifact);
  return next;
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
    this.tasks.set(taskId, cloneTask(task));
    return cloneTask(task);
  }

  async getTask(taskId: string): Promise<Task | null> {
    this._evictIfExpired(taskId);
    const task = this.tasks.get(taskId);
    return task ? cloneTask(task) : null;
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

    const next: Task = {
      ...task,
      ...(update.status ? { status: update.status } : {}),
      ...(update.artifacts ? { artifacts: update.artifacts } : {}),
      ...(update.history ? { history: update.history } : {}),
      ...(update.metadata
        ? { metadata: { ...task.metadata, ...update.metadata } }
        : {}),
    };

    // Track when a task enters a terminal state for TTL eviction
    if (update.status && TERMINAL_STATES.has(update.status.state)) {
      this.terminalTimestamps.set(taskId, Date.now());
    }

    this.tasks.set(taskId, cloneTask(next));
    return cloneTask(next);
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
