/**
 * Layer 3: AgentExecutor - bridges Runner/Agent with Task lifecycle.
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
    // Create or retrieve session
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

    try {
      for await (const event of this.runner.runAsync(session, message, abortController.signal)) {
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
          case 'done':
            // Collect accumulated text into an artifact (if any).
            if (textParts.length > 0) {
              artifacts.push({
                artifactId: `artifact-${task.id}-text`,
                parts: [{ text: textParts.join('') }],
              });
            }
            break;
          case 'error':
            task.status = {
              state: TaskState.FAILED,
              message: {
                messageId: `error-${Date.now()}`,
                role: 'agent',
                parts: [{ text: event.error.message }],
              },
              timestamp: new Date().toISOString(),
            };
            completedNormally = true;
            return task;
        }
      }

      // Set completed status (unless aborted by cancel)
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

    // Create session
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

    try {
      const textParts: string[] = [];
      const nonTextArtifacts: Artifact[] = [];
      let nonTextSeq = 0;

      for await (const event of this.runner.runAsync(session, message, abortController.signal)) {
        switch (event.type) {
          case 'text':
            textParts.push(event.text);
            // Emit artifact update for each text chunk
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

          case 'done': {
            const finalArtifacts: Artifact[] = [...nonTextArtifacts];

            // Emit final text artifact chunk if there was text
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

            // Emit completed status
            task.status = {
              state: TaskState.COMPLETED,
              timestamp: new Date().toISOString(),
            };
            yield {
              taskId: task.id,
              contextId,
              status: task.status,
            } satisfies TaskStatusUpdateEvent;
            break;
          }

          case 'error':
            task.status = {
              state: TaskState.FAILED,
              message: {
                messageId: `error-${Date.now()}`,
                role: 'agent',
                parts: [{ text: event.error.message }],
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
      // Abort any in-flight work if the generator was .return()ed by a
      // consumer (e.g. SSE client disconnect) before it could finish.
      // On normal completion / error / cancel this is a no-op.
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
    // Abort the running execution
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
