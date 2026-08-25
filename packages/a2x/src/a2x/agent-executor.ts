/**
 * Layer 3: AgentExecutor - bridges Runner/Agent with Task lifecycle.
 *
 * The default `AgentExecutor` understands one lifecycle event beyond the
 * familiar `text` / `file` / `data` / `done` / `error` set:
 *
 *  - `request-input` — yielded by the agent to ask the client for input
 *    (payment, approval, OAuth token, …). The executor halts the agent
 *    generator, sets `task.status = INPUT_REQUIRED`, and merges the
 *    agent's metadata onto the wire status message. No cross-turn
 *    bookkeeping is recorded; the agent re-derives its state on the
 *    resume turn by inspecting `InvocationContext.message`.
 *
 * The two terminal events (`done` and `error`) accept an optional
 * `metadata` field that the executor merges onto the final status
 * message — agents use this to attach extension result metadata (e.g.
 * x402 settlement receipts) without needing a dedicated event type.
 */

import { isDeepStrictEqual } from 'node:util';
import type { AgentArtifactDescriptor } from '../agent/base-agent.js';
import type { Message, Artifact } from '../types/common.js';
import type {
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types/task.js';
import { TaskState } from '../types/task.js';
import { Runner } from '../runner/runner.js';
import { cloneSnapshotValue } from './task-store.js';

// ─── RunConfig ───

export enum StreamingMode {
  SSE = 'SSE',
  NONE = 'NONE',
}

export interface RunConfig {
  streamingMode: StreamingMode;
  maxLlmCalls?: number;
}

// ─── AgentExecutor Options ───

export interface AgentExecutorOptions {
  runner: Runner;
  runConfig: RunConfig;
}

// ─── AgentExecutor ───

export class AgentExecutor {
  readonly runner: Runner;
  readonly runConfig: RunConfig;
  private readonly _abortControllers = new Map<string, Set<AbortController>>();

  constructor(options: AgentExecutorOptions) {
    this.runner = options.runner;
    this.runConfig = options.runConfig;
  }

  /**
   * Execute the agent synchronously (non-streaming).
   * Returns the completed Task.
   */
  async execute(
    task: Task,
    message: Message,
    options?: { activatedExtensions?: readonly string[] },
  ): Promise<Task> {
    const contextId = task.contextId ?? task.id;

    const abortController = new AbortController();
    this._registerAbortController(task.id, abortController);

    // Update task status to working
    task.status = {
      state: TaskState.WORKING,
      timestamp: new Date().toISOString(),
    };

    const artifacts: Artifact[] = [];
    const textParts: string[] = [];
    let textArtifact: AgentArtifactDescriptor | undefined;
    const artifactIds = new ArtifactIdAllocator(task.id, task.artifacts);
    let completedNormally = false;
    let inputRequested = false;

    try {
      const session = await this.runner.createSession();
      if (abortController.signal.aborted) return task;
      for await (const event of this.runner.runAsync(session, message, abortController.signal, {
        taskId: task.id,
        contextId,
        ...(options?.activatedExtensions
          ? { activatedExtensions: options.activatedExtensions }
          : {}),
      })) {
        switch (event.type) {
          case 'text':
            textArtifact = mergeTextArtifactDescriptor(
              textArtifact,
              event.artifact,
            );
            textParts.push(event.text);
            break;
          case 'file':
            artifacts.push({
              artifactId: artifactIds.next('file'),
              ...copyArtifactDescriptor(event.artifact),
              parts: [{ ...event.file }],
            });
            break;
          case 'data':
            artifacts.push({
              artifactId: artifactIds.next('data'),
              ...copyArtifactDescriptor(event.artifact),
              parts: [
                {
                  data: event.data,
                  ...(event.mediaType ? { mediaType: event.mediaType } : {}),
                },
              ],
            });
            break;
          case 'request-input': {
            inputRequested = true;
            // Content produced before the halt is part of the task
            // document. `executeStream` emits it as artifact events, so
            // dropping it here would lose it on `message/send` only.
            attachArtifacts(
              task,
              artifacts,
              textParts,
              artifactIds,
              textArtifact,
            );
            applyInputRequired(task, event.metadata, event.message);
            // Halt the agent's generator without raising — the for-await
            // unwinds via the explicit return below, and the finally
            // block will abort any in-flight work the runner started.
            completedNormally = true;
            return task;
          }
          case 'done':
            attachArtifacts(
              task,
              artifacts,
              textParts,
              artifactIds,
              textArtifact,
            );
            task.status = {
              state: TaskState.COMPLETED,
              timestamp: new Date().toISOString(),
              ...(event.metadata
                ? {
                    message: {
                      messageId: `completed-${Date.now()}`,
                      role: 'agent',
                      parts: [{ text: '' }],
                      metadata: { ...event.metadata },
                    },
                  }
                : {}),
            };
            completedNormally = true;
            return task;
          case 'error':
            attachArtifacts(
              task,
              artifacts,
              textParts,
              artifactIds,
              textArtifact,
            );
            task.status = {
              state: TaskState.FAILED,
              message: {
                messageId: `error-${Date.now()}`,
                role: 'agent',
                parts: [{ text: event.error.message }],
                ...(event.metadata ? { metadata: { ...event.metadata } } : {}),
              },
              timestamp: new Date().toISOString(),
            };
            completedNormally = true;
            return task;
        }
      }

      if (inputRequested) {
        // Already finalized inside the request-input branch.
        return task;
      }

      // Generator exhausted without an explicit done/error — synthesize a
      // completed status. This matches the legacy behavior for agents that
      // simply return from run() after emitting text.
      if (!abortController.signal.aborted) {
        attachArtifacts(
          task,
          artifacts,
          textParts,
          artifactIds,
          textArtifact,
        );
        task.status = {
          state: TaskState.COMPLETED,
          timestamp: new Date().toISOString(),
        };
      }
      completedNormally = true;
    } catch (error) {
      if (abortController.signal.aborted) return task;
      attachArtifacts(
        task,
        artifacts,
        textParts,
        artifactIds,
        textArtifact,
      );
      task.status = {
        state: TaskState.FAILED,
        message: {
          messageId: `error-${Date.now()}`,
          role: 'agent',
          parts: [
            {
              text:
                error instanceof Error
                  ? error.message
                  : 'Unknown error occurred',
            },
          ],
        },
        timestamp: new Date().toISOString(),
      };
      completedNormally = true;
    } finally {
      // Abort any in-flight work if the runner unwinds before producing a
      // lifecycle result.
      // On normal completion / error / cancel this is a no-op.
      if (!completedNormally && !abortController.signal.aborted) {
        abortController.abort();
      }
      this._unregisterAbortController(task.id, abortController);
    }

    return task;
  }

  /**
   * Execute the agent with streaming, yielding SSE events.
   */
  async *executeStream(
    task: Task,
    message: Message,
    options?: { activatedExtensions?: readonly string[] },
  ): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    const contextId = task.contextId ?? task.id;

    const abortController = new AbortController();
    this._registerAbortController(task.id, abortController);

    const artifactIds = new ArtifactIdAllocator(task.id, task.artifacts);
    let completedNormally = false;
    let inputRequested = false;
    const textParts: string[] = [];
    let textArtifact: AgentArtifactDescriptor | undefined;
    const nonTextArtifacts: Artifact[] = [];

    try {
      const session = await this.runner.createSession();
      if (abortController.signal.aborted) return;

      // Emit working status only after session creation succeeds. A session
      // setup failure is reported as FAILED below instead of stranding a
      // durably persisted task in WORKING.
      task.status = {
        state: TaskState.WORKING,
        timestamp: new Date().toISOString(),
      };
      yield {
        taskId: task.id,
        contextId,
        status: task.status,
        final: false,
      } satisfies TaskStatusUpdateEvent;

      for await (const event of this.runner.runAsync(session, message, abortController.signal, {
        taskId: task.id,
        contextId,
        ...(options?.activatedExtensions
          ? { activatedExtensions: options.activatedExtensions }
          : {}),
      })) {
        switch (event.type) {
          case 'text': {
            const append = textParts.length > 0;
            textArtifact = mergeTextArtifactDescriptor(
              textArtifact,
              event.artifact,
            );
            textParts.push(event.text);
            yield {
              taskId: task.id,
              contextId,
              artifact: {
                artifactId: artifactIds.text(),
                ...copyArtifactDescriptor(textArtifact),
                parts: [{ text: event.text }],
              },
              append,
              lastChunk: false,
              ...copyDeliveryMetadata(event.deliveryMetadata),
            } satisfies TaskArtifactUpdateEvent;
            break;
          }

          case 'file': {
            const artifact: Artifact = {
              artifactId: artifactIds.next('file'),
              ...copyArtifactDescriptor(event.artifact),
              parts: [{ ...event.file }],
            };
            nonTextArtifacts.push(artifact);
            yield {
              taskId: task.id,
              contextId,
              artifact,
              append: false,
              lastChunk: true,
              ...copyDeliveryMetadata(event.deliveryMetadata),
            } satisfies TaskArtifactUpdateEvent;
            break;
          }

          case 'data': {
            const artifact: Artifact = {
              artifactId: artifactIds.next('data'),
              ...copyArtifactDescriptor(event.artifact),
              parts: [
                {
                  data: event.data,
                  ...(event.mediaType ? { mediaType: event.mediaType } : {}),
                },
              ],
            };
            nonTextArtifacts.push(artifact);
            yield {
              taskId: task.id,
              contextId,
              artifact,
              append: false,
              lastChunk: true,
              ...copyDeliveryMetadata(event.deliveryMetadata),
            } satisfies TaskArtifactUpdateEvent;
            break;
          }

          case 'request-input': {
            inputRequested = true;
            attachArtifacts(
              task,
              nonTextArtifacts,
              textParts,
              artifactIds,
              textArtifact,
            );
            applyInputRequired(task, event.metadata, event.message);
            yield {
              taskId: task.id,
              contextId,
              status: task.status,
              final: true,
            } satisfies TaskStatusUpdateEvent;
            completedNormally = true;
            return;
          }

          case 'done': {
            const finalArtifacts: Artifact[] = [...nonTextArtifacts];

            if (textParts.length > 0) {
              const artifact: Artifact = {
                artifactId: artifactIds.text(),
                ...copyArtifactDescriptor(textArtifact),
                parts: [{ text: textParts.join('') }],
              };
              finalArtifacts.push(artifact);
              yield {
                taskId: task.id,
                contextId,
                artifact,
                append: false,
                lastChunk: true,
              } satisfies TaskArtifactUpdateEvent;
            }

            if (finalArtifacts.length > 0) {
              task.artifacts = finalArtifacts;
            }

            task.status = {
              state: TaskState.COMPLETED,
              timestamp: new Date().toISOString(),
              ...(event.metadata
                ? {
                    message: {
                      messageId: `completed-${Date.now()}`,
                      role: 'agent',
                      parts: [{ text: '' }],
                      metadata: { ...event.metadata },
                    },
                  }
                : {}),
            };
            yield {
              taskId: task.id,
              contextId,
              status: task.status,
              final: true,
            } satisfies TaskStatusUpdateEvent;
            completedNormally = true;
            return;
          }

          case 'error':
            attachArtifacts(
              task,
              nonTextArtifacts,
              textParts,
              artifactIds,
              textArtifact,
            );
            task.status = {
              state: TaskState.FAILED,
              message: {
                messageId: `error-${Date.now()}`,
                role: 'agent',
                parts: [{ text: event.error.message }],
                ...(event.metadata ? { metadata: { ...event.metadata } } : {}),
              },
              timestamp: new Date().toISOString(),
            };
            yield {
              taskId: task.id,
              contextId,
              status: task.status,
              final: true,
            } satisfies TaskStatusUpdateEvent;
            completedNormally = true;
            return;
        }
      }

      if (inputRequested) {
        return;
      }

      if (abortController.signal.aborted) return;

      // Agents may finish by returning instead of yielding `done`. Finalize
      // the same artifact set and status that the blocking path synthesizes.
      attachArtifacts(
        task,
        nonTextArtifacts,
        textParts,
        artifactIds,
        textArtifact,
      );
      if (textParts.length > 0) {
        yield {
          taskId: task.id,
          contextId,
          artifact: task.artifacts!.at(-1)!,
          append: false,
          lastChunk: true,
        } satisfies TaskArtifactUpdateEvent;
      }
      task.status = {
        state: TaskState.COMPLETED,
        timestamp: new Date().toISOString(),
      };
      yield {
        taskId: task.id,
        contextId,
        status: task.status,
        final: true,
      } satisfies TaskStatusUpdateEvent;
      completedNormally = true;
    } catch (error) {
      if (abortController.signal.aborted) return;
      attachArtifacts(
        task,
        nonTextArtifacts,
        textParts,
        artifactIds,
        textArtifact,
      );
      task.status = {
        state: TaskState.FAILED,
        message: {
          messageId: `error-${Date.now()}`,
          role: 'agent',
          parts: [
            {
              text:
                error instanceof Error
                  ? error.message
                  : 'Unknown error occurred',
            },
          ],
        },
        timestamp: new Date().toISOString(),
      };
      yield {
        taskId: task.id,
        contextId,
        status: task.status,
        final: true,
      } satisfies TaskStatusUpdateEvent;
      completedNormally = true;
    } finally {
      if (!completedNormally && !abortController.signal.aborted) {
        abortController.abort();
      }
      this._unregisterAbortController(task.id, abortController);
    }
  }

  /**
   * Cancel a running task. Aborts in-flight agent execution if running.
   */
  async cancel(task: Task): Promise<Task> {
    const controllers = this._abortControllers.get(task.id);
    if (controllers) {
      for (const controller of controllers) controller.abort();
      this._abortControllers.delete(task.id);
    }

    task.status = {
      state: TaskState.CANCELED,
      timestamp: new Date().toISOString(),
    };
    return task;
  }

  private _registerAbortController(
    taskId: string,
    controller: AbortController,
  ): void {
    let controllers = this._abortControllers.get(taskId);
    if (!controllers) {
      controllers = new Set();
      this._abortControllers.set(taskId, controllers);
    }
    controllers.add(controller);
  }

  private _unregisterAbortController(
    taskId: string,
    controller: AbortController,
  ): void {
    const controllers = this._abortControllers.get(taskId);
    if (!controllers) return;
    controllers.delete(controller);
    if (controllers.size === 0) this._abortControllers.delete(taskId);
  }
}

// ─── Module-private helpers ───

/**
 * Allocates artifact ids that stay unique across the turns of one task.
 *
 * A resumed task runs a fresh executor pass, so ids derived from a
 * per-run counter would repeat the previous turn's — and since
 * `artifactId` is what identifies an artifact within a task (spec
 * a2a-v0.3 §TaskArtifactUpdateEvent), a repeat silently supersedes the
 * earlier artifact instead of adding a new one. Ids are therefore
 * allocated against what the task already carries; a task's first turn
 * keeps the plain `-text` / `-data-1` form.
 */
class ArtifactIdAllocator {
  private readonly taskId: string;
  private readonly taken: Set<string>;
  private seq = 0;
  private textId: string | undefined;

  constructor(taskId: string, existing?: readonly Artifact[]) {
    this.taskId = taskId;
    this.taken = new Set((existing ?? []).map((a) => a.artifactId));
  }

  /** Stable within a turn — streamed chunks append to one text artifact. */
  text(): string {
    this.textId ??= this._claim(`artifact-${this.taskId}-text`);
    return this.textId;
  }

  next(kind: 'data' | 'file'): string {
    let id: string;
    do {
      id = `artifact-${this.taskId}-${kind}-${++this.seq}`;
    } while (this.taken.has(id));
    this.taken.add(id);
    return id;
  }

  private _claim(base: string): string {
    if (!this.taken.has(base)) {
      this.taken.add(base);
      return base;
    }
    let suffix = 2;
    while (this.taken.has(`${base}-${suffix}`)) suffix++;
    const id = `${base}-${suffix}`;
    this.taken.add(id);
    return id;
  }
}

/**
 * Attach what a non-streaming run collected, folding the accumulated text
 * chunks into the single text artifact `executeStream` emits under the
 * same id. Leaves `task.artifacts` untouched when the run produced
 * nothing, so a resumed task keeps what it already carried.
 */
function attachArtifacts(
  task: Task,
  artifacts: Artifact[],
  textParts: string[],
  artifactIds: ArtifactIdAllocator,
  textArtifact?: AgentArtifactDescriptor,
): void {
  const collected =
    textParts.length > 0
      ? [
          ...artifacts,
          {
            artifactId: artifactIds.text(),
            ...copyArtifactDescriptor(textArtifact),
            parts: [{ text: textParts.join('') }],
          },
        ]
      : artifacts;

  if (collected.length > 0) {
    task.artifacts = collected;
  }
}

function copyArtifactDescriptor(
  descriptor?: AgentArtifactDescriptor,
): AgentArtifactDescriptor {
  if (!descriptor) return {};
  return {
    ...(descriptor.name !== undefined ? { name: descriptor.name } : {}),
    ...(descriptor.description !== undefined
      ? { description: descriptor.description }
      : {}),
    ...(descriptor.metadata !== undefined
      ? { metadata: cloneSnapshotValue(descriptor.metadata) }
      : {}),
    ...(descriptor.extensions !== undefined
      ? { extensions: [...descriptor.extensions] }
      : {}),
  };
}

function copyDeliveryMetadata(
  metadata: Record<string, unknown> | undefined,
): Pick<TaskArtifactUpdateEvent, 'metadata'> {
  return metadata === undefined
    ? {}
    : { metadata: cloneSnapshotValue(metadata) };
}

/**
 * Text chunks form one durable artifact, so descriptor fields accumulate
 * across the run. Scalar fields cannot change, extensions form a stable
 * union, and metadata keys may only be repeated with deeply equal values.
 */
function mergeTextArtifactDescriptor(
  current: AgentArtifactDescriptor | undefined,
  incoming: AgentArtifactDescriptor | undefined,
): AgentArtifactDescriptor | undefined {
  if (!incoming) return current;
  if (!current) return copyArtifactDescriptor(incoming);

  const merged = copyArtifactDescriptor(current);

  for (const field of ['name', 'description'] as const) {
    const next = incoming[field];
    if (next === undefined) continue;
    const previous = merged[field];
    if (previous !== undefined && previous !== next) {
      throw new Error(`Conflicting text artifact ${field}`);
    }
    merged[field] = next;
  }

  if (incoming.extensions !== undefined) {
    merged.extensions = [
      ...new Set([...(merged.extensions ?? []), ...incoming.extensions]),
    ];
  }

  if (incoming.metadata !== undefined) {
    const metadata = { ...(merged.metadata ?? {}) };
    const incomingMetadata = cloneSnapshotValue(incoming.metadata);
    for (const [key, value] of Object.entries(incomingMetadata)) {
      if (Object.prototype.hasOwnProperty.call(metadata, key)) {
        if (!isDeepStrictEqual(metadata[key], value)) {
          throw new Error(`Conflicting text artifact metadata key: ${key}`);
        }
        continue;
      }
      Object.defineProperty(metadata, key, {
        value,
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    merged.metadata = metadata;
  }

  return merged;
}

/**
 * Set the task to INPUT_REQUIRED, merging the agent-supplied metadata
 * onto the wire status message. The default human-readable status text
 * falls back to a generic line when the agent didn't supply one.
 */
function applyInputRequired(
  task: Task,
  metadata: Record<string, unknown>,
  messageText?: string,
): void {
  task.status = {
    state: TaskState.INPUT_REQUIRED,
    timestamp: new Date().toISOString(),
    message: {
      messageId: `input-required-${Date.now()}`,
      role: 'agent',
      parts: [{ text: messageText ?? 'Input is required to continue.' }],
      metadata: { ...metadata },
    },
  };
}
