/**
 * Layer 3: AgentExecutor - bridges Runner/Agent with Task lifecycle.
 */

import type { AgentEvent } from '../agent/base-agent.js';
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

    // Update task status to working
    task.status = {
      state: TaskState.WORKING,
      timestamp: new Date().toISOString(),
    };

    const artifacts: Artifact[] = [];
    const textParts: string[] = [];

    try {
      for await (const event of this.runner.runAsync(session, message)) {
        switch (event.type) {
          case 'text':
            textParts.push(event.text);
            break;
          case 'done':
            // Collect text parts into an artifact
            if (textParts.length > 0) {
              artifacts.push({
                artifactId: `artifact-${Date.now()}`,
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
            return task;
        }
      }

      // Set completed status
      task.status = {
        state: TaskState.COMPLETED,
        timestamp: new Date().toISOString(),
      };
      if (artifacts.length > 0) {
        task.artifacts = artifacts;
      }
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

    try {
      const textParts: string[] = [];

      for await (const event of this.runner.runAsync(session, message)) {
        switch (event.type) {
          case 'text':
            textParts.push(event.text);
            // Emit artifact update for each text chunk
            yield {
              taskId: task.id,
              contextId,
              artifact: {
                artifactId: `artifact-${task.id}`,
                parts: [{ text: event.text }],
              },
              append: true,
              lastChunk: false,
            } satisfies TaskArtifactUpdateEvent;
            break;

          case 'done': {
            // Emit final artifact chunk if there was text
            if (textParts.length > 0) {
              const artifact: Artifact = {
                artifactId: `artifact-${task.id}`,
                parts: [{ text: textParts.join('') }],
              };
              task.artifacts = [artifact];
              yield {
                taskId: task.id,
                contextId,
                artifact,
                append: false,
                lastChunk: true,
              } satisfies TaskArtifactUpdateEvent;
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
            return;
        }
      }
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
    }
  }

  /**
   * Cancel a running task.
   */
  async cancel(task: Task): Promise<Task> {
    task.status = {
      state: TaskState.CANCELED,
      timestamp: new Date().toISOString(),
    };
    return task;
  }
}
