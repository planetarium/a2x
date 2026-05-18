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

import type { Message, Artifact } from '../types/common.js';
import type {
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types/task.js';
import { TaskState } from '../types/task.js';
import { Runner } from '../runner/runner.js';

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
  private readonly _abortControllers = new Map<string, AbortController>();

  constructor(options: AgentExecutorOptions) {
    this.runner = options.runner;
    this.runConfig = options.runConfig;
  }

  /**
   * Execute the agent synchronously (non-streaming).
   * Returns the completed Task.
   */
  async execute(task: Task, message: Message): Promise<Task> {
    const contextId = task.contextId ?? task.id;

    const session = await this.runner.createSession();
    const abortController = new AbortController();
    this._abortControllers.set(task.id, abortController);

    // Update task status to working
    task.status = {
      state: TaskState.WORKING,
      timestamp: new Date().toISOString(),
    };

    const artifacts: Artifact[] = [];
    const textParts: string[] = [];
    let nonTextSeq = 0;
    let completedNormally = false;
    let inputRequested = false;

    try {
      for await (const event of this.runner.runAsync(session, message, abortController.signal, {
        taskId: task.id,
        contextId,
      })) {
        switch (event.type) {
          case 'text':
            textParts.push(event.text);
            break;
          case 'file':
            artifacts.push({
              artifactId: `artifact-${task.id}-file-${++nonTextSeq}`,
              parts: [{ ...event.file }],
            });
            break;
          case 'data':
            artifacts.push({
              artifactId: `artifact-${task.id}-data-${++nonTextSeq}`,
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
            applyInputRequired(task, event.metadata, event.message);
            // Halt the agent's generator without raising — the for-await
            // unwinds via the explicit return below, and the finally
            // block will abort any in-flight work the runner started.
            completedNormally = true;
            return task;
          }
          case 'done':
            // Collect accumulated text into an artifact (if any).
            if (textParts.length > 0) {
              artifacts.push({
                artifactId: `artifact-${task.id}-text`,
                parts: [{ text: textParts.join('') }],
              });
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
            if (artifacts.length > 0) {
              task.artifacts = artifacts;
            }
            completedNormally = true;
            return task;
          case 'error':
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
        task.status = {
          state: TaskState.COMPLETED,
          timestamp: new Date().toISOString(),
        };
        if (artifacts.length > 0) {
          task.artifacts = artifacts;
        }
      }
      completedNormally = true;
    } catch (error) {
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
      // Abort any in-flight work if the awaiter exited abnormally
      // (e.g. generator was .return()ed by an SSE client disconnect).
      // On normal completion / error / cancel this is a no-op.
      if (!completedNormally && !abortController.signal.aborted) {
        abortController.abort();
      }
      this._abortControllers.delete(task.id);
    }

    return task;
  }

  /**
   * Execute the agent with streaming, yielding SSE events.
   */
  async *executeStream(
    task: Task,
    message: Message,
  ): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    const contextId = task.contextId ?? task.id;

    const session = await this.runner.createSession();
    const abortController = new AbortController();
    this._abortControllers.set(task.id, abortController);

    // Emit working status
    task.status = {
      state: TaskState.WORKING,
      timestamp: new Date().toISOString(),
    };
    yield {
      taskId: task.id,
      contextId,
      status: task.status,
    };

    let completedNormally = false;
    let inputRequested = false;

    try {
      const textParts: string[] = [];
      const nonTextArtifacts: Artifact[] = [];
      let nonTextSeq = 0;

      for await (const event of this.runner.runAsync(session, message, abortController.signal, {
        taskId: task.id,
        contextId,
      })) {
        switch (event.type) {
          case 'text':
            textParts.push(event.text);
            yield {
              taskId: task.id,
              contextId,
              artifact: {
                artifactId: `artifact-${task.id}-text`,
                parts: [{ text: event.text }],
              },
              append: true,
              lastChunk: false,
            } satisfies TaskArtifactUpdateEvent;
            break;

          case 'file': {
            const artifact: Artifact = {
              artifactId: `artifact-${task.id}-file-${++nonTextSeq}`,
              parts: [{ ...event.file }],
            };
            nonTextArtifacts.push(artifact);
            yield {
              taskId: task.id,
              contextId,
              artifact,
              append: false,
              lastChunk: true,
            } satisfies TaskArtifactUpdateEvent;
            break;
          }

          case 'data': {
            const artifact: Artifact = {
              artifactId: `artifact-${task.id}-data-${++nonTextSeq}`,
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
            } satisfies TaskArtifactUpdateEvent;
            break;
          }

          case 'request-input': {
            inputRequested = true;
            applyInputRequired(task, event.metadata, event.message);
            yield {
              taskId: task.id,
              contextId,
              status: task.status,
            } satisfies TaskStatusUpdateEvent;
            completedNormally = true;
            return;
          }

          case 'done': {
            const finalArtifacts: Artifact[] = [...nonTextArtifacts];

            if (textParts.length > 0) {
              const artifact: Artifact = {
                artifactId: `artifact-${task.id}-text`,
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
            } satisfies TaskStatusUpdateEvent;
            completedNormally = true;
            return;
          }

          case 'error':
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
            } satisfies TaskStatusUpdateEvent;
            completedNormally = true;
            return;
        }
      }

      if (inputRequested) {
        return;
      }
      completedNormally = true;
    } catch (error) {
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
      } satisfies TaskStatusUpdateEvent;
      completedNormally = true;
    } finally {
      if (!completedNormally && !abortController.signal.aborted) {
        abortController.abort();
      }
      this._abortControllers.delete(task.id);
    }
  }

  /**
   * Cancel a running task. Aborts in-flight agent execution if running.
   */
  async cancel(task: Task): Promise<Task> {
    const controller = this._abortControllers.get(task.id);
    if (controller) {
      controller.abort();
      this._abortControllers.delete(task.id);
    }

    task.status = {
      state: TaskState.CANCELED,
      timestamp: new Date().toISOString(),
    };
    return task;
  }
}

// ─── Module-private helpers ───

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
