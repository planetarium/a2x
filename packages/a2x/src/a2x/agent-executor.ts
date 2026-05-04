/**
 * Layer 3: AgentExecutor - bridges Runner/Agent with Task lifecycle.
 *
 * The default `AgentExecutor` understands two lifecycle events beyond the
 * familiar `text`/`file`/`data`/`done`/`error` set:
 *
 *  - `request-input` — yielded by the agent to ask the client for input
 *    (payment, approval, OAuth token …). The executor halts the agent
 *    generator, sets `task.status = INPUT_REQUIRED`, merges the agent's
 *    metadata onto the wire status message, and stashes a small private
 *    record on the task so the resume turn can read what was asked for.
 *  - resume turns — when the client re-submits a message on a task that
 *    last emitted `request-input`, the executor consults its
 *    `inputRoundTripHooks` map keyed by `domain`, runs the hook (e.g.
 *    x402 verify+settle), applies the hook's outcome (terminate /
 *    reissue / intermediate / data / final-metadata patch), and re-runs
 *    the agent with `InvocationContext.input` populated.
 *
 * The two new behaviors are surfaced behind the same `execute` /
 * `executeStream` / `cancel` signatures the rest of the SDK already
 * depends on. Callers that don't register any hooks see the executor
 * behave exactly as before.
 */

import type { Message, Artifact } from '../types/common.js';
import type {
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types/task.js';
import { TaskState } from '../types/task.js';
import { Runner } from '../runner/runner.js';
import {
  INPUT_ROUNDTRIP_METADATA_KEY,
  type InputRoundTripContext,
  type InputRoundTripHook,
  type InputRoundTripOutcome,
  type InputRoundTripRecord,
} from './input-roundtrip.js';

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
  /**
   * Hooks for input-required round-trips. Keyed internally by `domain`
   * (e.g. `'x402'`). The executor consults this map on resume turns to
   * verify payment / approval tokens / etc. Late registration via
   * `registerInputRoundTripHook` is also supported (parity with
   * `A2XClient.registerExtension`).
   */
  inputRoundTripHooks?: InputRoundTripHook[];
}

// ─── AgentExecutor ───

export class AgentExecutor {
  readonly runner: Runner;
  readonly runConfig: RunConfig;
  private readonly _abortControllers = new Map<string, AbortController>();
  private readonly _hooks = new Map<string, InputRoundTripHook>();

  constructor(options: AgentExecutorOptions) {
    this.runner = options.runner;
    this.runConfig = options.runConfig;
    for (const hook of options.inputRoundTripHooks ?? []) {
      this._hooks.set(hook.domain, hook);
    }
  }

  /**
   * Register a hook for a specific input-required domain after
   * construction. Useful when the consumer wants to add a hook based on
   * runtime configuration discovered after the executor was wired.
   */
  registerInputRoundTripHook(hook: InputRoundTripHook): void {
    this._hooks.set(hook.domain, hook);
  }

  /**
   * Execute the agent synchronously (non-streaming).
   * Returns the completed Task.
   */
  async execute(task: Task, message: Message): Promise<Task> {
    // Detect a resume turn by reading the round-trip record off the task's
    // status message metadata. Persisted by the prior turn's
    // applyInputRequired() call.
    const priorRecord = readInputRoundTripRecord(task);

    // Resume-turn hook dispatch. The hook's outcome can short-circuit the
    // turn (terminate / reissue input-required) or simply produce data
    // the agent's second run reads back via context.input.outcome.
    let resumeOutcome: InputRoundTripOutcome | undefined;
    if (priorRecord) {
      const hook = this._hooks.get(priorRecord.domain);
      if (hook) {
        try {
          resumeOutcome = await hook.handleResume({
            message,
            previous: priorRecord,
          });
        } catch (error) {
          applyAgentErrorStatus(task, error);
          return task;
        }

        if (resumeOutcome.terminate) {
          applyTerminate(task, resumeOutcome.terminate);
          return task;
        }

        if (resumeOutcome.reissueInputRequired) {
          // Re-issue with the prior record's domain so the client (and a
          // future resume hook) can match it again. `payload` may be
          // overridden by the outcome (e.g. retry-with-error variant).
          const nextRecord: InputRoundTripRecord = {
            domain: priorRecord.domain,
            payload:
              resumeOutcome.reissueInputRequired.payload !== undefined
                ? resumeOutcome.reissueInputRequired.payload
                : priorRecord.payload,
            emittedMetadata: resumeOutcome.reissueInputRequired.metadata,
            emittedAt: new Date().toISOString(),
          };
          applyInputRequired(
            task,
            resumeOutcome.reissueInputRequired.metadata,
            nextRecord,
          );
          return task;
        }
      }
    }

    const session = await this.runner.createSession();
    const abortController = new AbortController();
    this._abortControllers.set(task.id, abortController);

    // Surface the round-trip context to the agent on resume turns so it
    // can branch ("am I being resumed after the user paid?") without
    // recomputing the prior turn's intent.
    const inputContext: InputRoundTripContext | undefined = priorRecord
      ? {
        previous: priorRecord,
        outcome: resumeOutcome,
        resumeMetadata: (message.metadata ?? {}) as Record<string, unknown>,
      }
      : undefined;
    if (inputContext) {
      attachInvocationInput(session, inputContext);
    }

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
          case 'request-input': {
            const domain = event.domain;
            if (typeof domain !== 'string' || domain.length === 0) {
              throw new Error(
                'request-input AgentEvent requires a non-empty `domain`.',
              );
            }
            inputRequested = true;
            const record: InputRoundTripRecord = {
              domain,
              payload: event.payload,
              emittedMetadata: event.metadata,
              emittedAt: new Date().toISOString(),
            };
            applyInputRequired(task, event.metadata, record, event.message);
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

      if (inputRequested) {
        // Already finalized inside the request-input branch.
        return task;
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
        // Resume-turn outcome (e.g. x402 receipts) merges into the final
        // task message metadata after a successful agent run.
        if (resumeOutcome?.finalMetadataPatch) {
          mergeFinalMetadataPatch(task, resumeOutcome.finalMetadataPatch);
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

    // Resume-turn hook dispatch (mirror of execute()).
    const priorRecord = readInputRoundTripRecord(task);
    let resumeOutcome: InputRoundTripOutcome | undefined;
    if (priorRecord) {
      const hook = this._hooks.get(priorRecord.domain);
      if (hook) {
        try {
          resumeOutcome = await hook.handleResume({
            message,
            previous: priorRecord,
          });
        } catch (error) {
          applyAgentErrorStatus(task, error);
          yield { taskId: task.id, contextId, status: task.status };
          return;
        }

        if (resumeOutcome.terminate) {
          applyTerminate(task, resumeOutcome.terminate);
          yield { taskId: task.id, contextId, status: task.status };
          return;
        }

        if (resumeOutcome.reissueInputRequired) {
          const nextRecord: InputRoundTripRecord = {
            domain: priorRecord.domain,
            payload:
              resumeOutcome.reissueInputRequired.payload !== undefined
                ? resumeOutcome.reissueInputRequired.payload
                : priorRecord.payload,
            emittedMetadata: resumeOutcome.reissueInputRequired.metadata,
            emittedAt: new Date().toISOString(),
          };
          applyInputRequired(
            task,
            resumeOutcome.reissueInputRequired.metadata,
            nextRecord,
          );
          yield { taskId: task.id, contextId, status: task.status };
          return;
        }
      }
    }

    // Create session
    const session = await this.runner.createSession();
    const abortController = new AbortController();
    this._abortControllers.set(task.id, abortController);

    const inputContext: InputRoundTripContext | undefined = priorRecord
      ? {
        previous: priorRecord,
        outcome: resumeOutcome,
        resumeMetadata: (message.metadata ?? {}) as Record<string, unknown>,
      }
      : undefined;
    if (inputContext) {
      attachInvocationInput(session, inputContext);
    }

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

    // Emit the resume hook's intermediate state (e.g. x402 payment-verified)
    // before the agent starts running again.
    if (resumeOutcome?.intermediate) {
      task.status = {
        state: TaskState.WORKING,
        timestamp: new Date().toISOString(),
        message: {
          messageId: `intermediate-${Date.now()}`,
          role: 'agent',
          parts: [{ text: '' }],
          metadata: { ...resumeOutcome.intermediate.metadata },
        },
      };
      yield {
        taskId: task.id,
        contextId,
        status: task.status,
      } satisfies TaskStatusUpdateEvent;
    }

    let completedNormally = false;
    let inputRequested = false;

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

          case 'request-input': {
            const domain = event.domain;
            if (typeof domain !== 'string' || domain.length === 0) {
              throw new Error(
                'request-input AgentEvent requires a non-empty `domain`.',
              );
            }
            inputRequested = true;
            const record: InputRoundTripRecord = {
              domain,
              payload: event.payload,
              emittedMetadata: event.metadata,
              emittedAt: new Date().toISOString(),
            };
            applyInputRequired(task, event.metadata, record, event.message);
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
            if (resumeOutcome?.finalMetadataPatch) {
              mergeFinalMetadataPatch(task, resumeOutcome.finalMetadataPatch);
            }
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
      if (inputRequested) {
        // Already finalized inside the request-input branch.
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

// ─── Module-private helpers ───

/**
 * Read the round-trip bookkeeping record off the task. Returns undefined
 * when the prior turn wasn't an input-required round-trip (or the task is
 * fresh). The record is stored under a private key so wire clients that
 * don't know about it ignore it (per A2A's open-metadata convention).
 */
function readInputRoundTripRecord(
  task: Task,
): InputRoundTripRecord | undefined {
  const meta = (task.status.message?.metadata ?? {}) as Record<string, unknown>;
  const raw = meta[INPUT_ROUNDTRIP_METADATA_KEY];
  if (!raw || typeof raw !== 'object') return undefined;
  const candidate = raw as Partial<InputRoundTripRecord>;
  if (
    typeof candidate.domain !== 'string' ||
    candidate.domain.length === 0 ||
    typeof candidate.emittedMetadata !== 'object' ||
    candidate.emittedMetadata === null ||
    typeof candidate.emittedAt !== 'string'
  ) {
    return undefined;
  }
  return {
    domain: candidate.domain,
    payload: candidate.payload,
    emittedMetadata: candidate.emittedMetadata as Record<string, unknown>,
    emittedAt: candidate.emittedAt,
  };
}

/**
 * Set the task to INPUT_REQUIRED, merging the agent-supplied metadata
 * onto the wire status message and stashing the round-trip record under
 * the SDK's private key. The default human-readable status text falls
 * back to a generic line when the agent didn't supply one.
 */
function applyInputRequired(
  task: Task,
  metadata: Record<string, unknown>,
  record: InputRoundTripRecord,
  messageText?: string,
): void {
  task.status = {
    state: TaskState.INPUT_REQUIRED,
    timestamp: new Date().toISOString(),
    message: {
      messageId: `input-required-${Date.now()}`,
      role: 'agent',
      parts: [{ text: messageText ?? 'Input is required to continue.' }],
      metadata: {
        ...metadata,
        [INPUT_ROUNDTRIP_METADATA_KEY]: record,
      },
    },
  };
}

/** Apply a hook-driven terminal state (failed / rejected). */
function applyTerminate(
  task: Task,
  terminate: NonNullable<InputRoundTripOutcome['terminate']>,
): void {
  const targetState =
    terminate.state === 'rejected' ? TaskState.REJECTED : TaskState.FAILED;
  task.status = {
    state: targetState,
    timestamp: new Date().toISOString(),
    message: {
      messageId: `terminate-${Date.now()}`,
      role: 'agent',
      parts: [{ text: terminate.reason ?? 'Round-trip terminated by hook.' }],
      metadata: { ...(terminate.metadata ?? {}) },
    },
  };
}

/**
 * Merge the hook's `finalMetadataPatch` into the completed task's status
 * message metadata. We synthesize a status message when the agent didn't
 * emit one (e.g. agent only yielded `done`) so the receipts have a place
 * to land.
 */
function mergeFinalMetadataPatch(
  task: Task,
  patch: Record<string, unknown>,
): void {
  if (!task.status.message) {
    task.status.message = {
      messageId: `final-${Date.now()}`,
      role: 'agent',
      parts: [{ text: '' }],
      metadata: {},
    };
  }
  const existing = (task.status.message.metadata ?? {}) as Record<
    string,
    unknown
  >;
  task.status.message.metadata = { ...existing, ...patch };
}

/**
 * Surface the resume-turn round-trip context to the agent via the
 * Runner-supplied `InvocationContext`. The Runner builds the context off
 * `session.state` lookups, so we stash it under a sentinel key the
 * Runner reads back when constructing the context. See `runner/runner.ts`.
 */
function attachInvocationInput(
  session: { state: Record<string, unknown> },
  input: InputRoundTripContext,
): void {
  session.state[INVOCATION_INPUT_SENTINEL_KEY] = input;
}

/** Session-state sentinel the Runner reads to populate `InvocationContext.input`. */
export const INVOCATION_INPUT_SENTINEL_KEY = '__a2x_invocation_input__';

function applyAgentErrorStatus(task: Task, error: unknown): void {
  task.status = {
    state: TaskState.FAILED,
    message: {
      messageId: `error-${Date.now()}`,
      role: 'agent',
      parts: [
        {
          text: error instanceof Error ? error.message : 'Unknown error occurred',
        },
      ],
    },
    timestamp: new Date().toISOString(),
  };
}
