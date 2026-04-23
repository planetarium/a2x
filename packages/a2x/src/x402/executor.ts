/**
 * `X402PaymentExecutor` wraps an existing `AgentExecutor` with x402
 * payment coordination. It supports both flows from a2a-x402 v0.2:
 *
 *  - **Standalone (gate) flow.** The first message to a task triggers a
 *    `payment-required` response carrying the `x402PaymentRequiredResponse`
 *    in `task.status.message.metadata`. The client signs a `PaymentPayload`
 *    and resubmits the same task; the executor verifies + settles and then
 *    runs the inner agent.
 *
 *  - **Embedded flow.** While the inner agent is running it can yield
 *    `{ type: 'paymentRequired', ... }` to request an additional charge.
 *    The executor converts that into an artifact-shaped challenge
 *    (per spec §5.3 Embedded example), transitions the task back into
 *    `input-required`, and suspends execution. When the client resubmits
 *    with a signed payload, the executor verifies + settles and resumes
 *    the inner agent generator from where it paused.
 *
 * The two flows compose: a gate-zero or gate-skipped setup can rely on
 * embedded charges exclusively, or they can stack (gate + one or more
 * embedded charges per task).
 *
 * The wrapper preserves the `AgentExecutor` public surface (runner,
 * runConfig, execute, executeStream, cancel) so it can be dropped into
 * `A2XAgent` transparently.
 */

import type { Artifact, Message } from '../types/common.js';
import type {
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types/task.js';
import { TaskState } from '../types/task.js';
import { AgentExecutor } from '../a2x/agent-executor.js';
import type { AgentEvent } from '../agent/base-agent.js';
import type { Session } from '../runner/context.js';
import {
  X402_ERROR_CODES,
  X402_DEFAULT_RESOURCE,
  X402_DEFAULT_TIMEOUT_SECONDS,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
  type X402ErrorCode,
} from './constants.js';
import { resolveFacilitator, type FacilitatorUrlConfig } from './facilitator.js';
import type {
  X402Accept,
  X402Facilitator,
  X402PaymentPayload,
  X402PaymentRequirements,
  X402PaymentRequiredResponse,
  X402SettleResponse,
} from './types.js';

/** Artifact name the SDK uses for bare embedded challenges. */
export const X402_EMBEDDED_ARTIFACT_NAME = 'x402-payment-required';

/** Data-part key the SDK uses for bare embedded challenges. */
export const X402_EMBEDDED_DATA_KEY = 'x402.payment.required';

export interface X402ResolveAcceptsContext {
  /** The task the inner agent is running against. */
  task: Task;
  /** The message that triggered the current execution. */
  message: Message;
  /** Higher-level embedded object the agent emitted alongside the event. */
  embeddedObject?: unknown;
}

export interface X402PaymentExecutorOptions {
  /**
   * Payment options offered at the Standalone gate. Omit or pass `[]` to
   * skip the gate entirely and rely solely on Embedded flow charges.
   */
  accepts?: X402Accept[];
  /**
   * Facilitator that performs on-chain verify/settle. Either a URL config
   * (uses `useFacilitator()` from x402/verify), a fully custom
   * `{ verify, settle }` pair, or omitted (default Coinbase facilitator).
   */
  facilitator?: FacilitatorUrlConfig | X402Facilitator;
  /**
   * Optional predicate: receive the incoming message and decide whether
   * to require gate payment. Return `false` for requests that should pass
   * through the gate without charging. Default: gate runs whenever
   * `accepts` is non-empty.
   */
  requiresPayment?: (message: Message) => boolean;
  /**
   * Resolver for Embedded flow. Invoked when the inner agent yields
   * `{ type: 'paymentRequired' }` without inline `accepts`. Use this to
   * price per-action (cart totals, premium content, etc.).
   */
  resolveAccepts?: (
    context: X402ResolveAcceptsContext,
  ) => X402Accept[] | Promise<X402Accept[]>;
}

interface ResolvedConfig {
  accepts: X402PaymentRequirements[];
  facilitator: X402Facilitator;
  requiresPayment?: (message: Message) => boolean;
  resolveAccepts?: (
    context: X402ResolveAcceptsContext,
  ) => X402Accept[] | Promise<X402Accept[]>;
}

interface PendingEmbeddedState {
  iterator: AsyncIterator<AgentEvent>;
  session: Session;
  controller: AbortController;
  accepts: X402PaymentRequirements[];
  challengeArtifactId: string;
  textArtifactId: string;
  textParts: string[];
  priorReceipts: X402SettleResponse[];
}

export class X402PaymentExecutor extends AgentExecutor {
  private readonly _inner: AgentExecutor;
  private readonly _config: ResolvedConfig;
  private readonly _pending = new Map<string, PendingEmbeddedState>();

  constructor(inner: AgentExecutor, options: X402PaymentExecutorOptions) {
    super({ runner: inner.runner, runConfig: inner.runConfig });
    this._inner = inner;
    this._config = resolveOptions(options);
  }

  override async execute(task: Task, message: Message): Promise<Task> {
    const pending = this._pending.get(task.id);
    if (pending) {
      return this._resumeEmbeddedNonStream(task, message, pending);
    }

    if (this._shouldRunGate(message)) {
      const gateOutcome = await this._runGateNonStream(task, message);
      if (gateOutcome.action !== 'continue') {
        return task;
      }
      // Gate passed; inner run gets the message with payment receipts attached.
      return this._runInnerNonStream(task, message, [gateOutcome.receipt]);
    }

    return this._runInnerNonStream(task, message, []);
  }

  override async *executeStream(
    task: Task,
    message: Message,
  ): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    const pending = this._pending.get(task.id);
    if (pending) {
      yield* this._resumeEmbeddedStream(task, message, pending);
      return;
    }

    if (this._shouldRunGate(message)) {
      const gateOutcome = yield* this._runGateStream(task, message);
      if (gateOutcome.action !== 'continue') {
        return;
      }
      yield* this._runInnerStream(task, message, [gateOutcome.receipt]);
      return;
    }

    yield* this._runInnerStream(task, message, []);
  }

  override async cancel(task: Task): Promise<Task> {
    const pending = this._pending.get(task.id);
    if (pending) {
      pending.controller.abort();
      try {
        await pending.iterator.return?.(undefined);
      } catch {
        // Generators may throw on .return(); we don't care during cancel.
      }
      this._pending.delete(task.id);
    }
    return this._inner.cancel(task);
  }

  // ─── Gate (Standalone flow) ────────────────────────────────────────────

  private _shouldRunGate(message: Message): boolean {
    if (this._config.accepts.length === 0) return false;
    const predicate = this._config.requiresPayment;
    return predicate ? predicate(message) : true;
  }

  private async _runGateNonStream(
    task: Task,
    message: Message,
  ): Promise<GateOutcome> {
    const status = getPaymentStatus(message);
    if (status !== X402_PAYMENT_STATUS.SUBMITTED) {
      applyPaymentRequiredStatus(task, {
        x402Version: 1,
        accepts: this._config.accepts,
      });
      return { action: 'emit-required' };
    }

    const verdict = await this._verifyAndSettle(
      getPaymentPayload(message),
      this._config.accepts,
    );
    if (verdict.kind === 'failure') {
      applyFailedPaymentStatus(task, verdict.code, verdict.reason, verdict.network);
      return { action: 'failed' };
    }
    return { action: 'continue', receipt: verdict.receipt };
  }

  private async *_runGateStream(
    task: Task,
    message: Message,
  ): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent, GateOutcome> {
    const contextId = task.contextId ?? task.id;
    const status = getPaymentStatus(message);
    if (status !== X402_PAYMENT_STATUS.SUBMITTED) {
      applyPaymentRequiredStatus(task, {
        x402Version: 1,
        accepts: this._config.accepts,
      });
      yield { taskId: task.id, contextId, status: task.status };
      return { action: 'emit-required' };
    }

    const verdict = await this._verifyAndSettle(
      getPaymentPayload(message),
      this._config.accepts,
    );
    if (verdict.kind === 'failure') {
      applyFailedPaymentStatus(task, verdict.code, verdict.reason, verdict.network);
      yield { taskId: task.id, contextId, status: task.status };
      return { action: 'failed' };
    }
    return { action: 'continue', receipt: verdict.receipt };
  }

  // ─── Inner run (with embedded interception) ────────────────────────────

  private async _runInnerNonStream(
    task: Task,
    message: Message,
    priorReceipts: X402SettleResponse[],
  ): Promise<Task> {
    const session = await this.runner.createSession();
    const controller = new AbortController();
    const rawIterator = this.runner
      .runAsync(session, message, controller.signal)
      [Symbol.asyncIterator]();

    task.status = {
      state: TaskState.WORKING,
      timestamp: new Date().toISOString(),
    };

    const textArtifactId = `artifact-${task.id}`;
    const textParts: string[] = [];

    return this._driveNonStream(
      task,
      rawIterator,
      session,
      controller,
      textArtifactId,
      textParts,
      priorReceipts,
    );
  }

  private async _driveNonStream(
    task: Task,
    iterator: AsyncIterator<AgentEvent>,
    session: Session,
    controller: AbortController,
    textArtifactId: string,
    textParts: string[],
    priorReceipts: X402SettleResponse[],
  ): Promise<Task> {
    const contextId = task.contextId ?? task.id;
    try {
      while (true) {
        const { value: event, done } = await iterator.next();
        if (done) break;

        switch (event.type) {
          case 'text':
            textParts.push(event.text);
            break;
          case 'paymentRequired': {
            const outcome = await this._emitPaymentRequired(
              task,
              event,
              iterator,
              session,
              controller,
              textArtifactId,
              textParts,
              priorReceipts,
            );
            if (outcome === 'failed') return task;
            return task;
          }
          case 'done':
            // Handled after the loop.
            break;
          case 'error':
            task.status = {
              state: TaskState.FAILED,
              timestamp: new Date().toISOString(),
              message: {
                messageId: `error-${Date.now()}`,
                role: 'agent',
                parts: [{ text: event.error.message }],
              },
            };
            return task;
        }
      }

      if (!controller.signal.aborted) {
        if (textParts.length > 0) {
          appendArtifact(task, {
            artifactId: textArtifactId,
            parts: [{ text: textParts.join('') }],
          });
        }
        task.status = {
          state: TaskState.COMPLETED,
          timestamp: new Date().toISOString(),
        };
        if (priorReceipts.length > 0) {
          attachReceipts(task, priorReceipts);
        }
      }
      return task;
    } catch (error) {
      task.status = {
        state: TaskState.FAILED,
        timestamp: new Date().toISOString(),
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
      };
      return task;
    } finally {
      // Only fire abort if we didn't stash the iterator for resumption.
      if (!this._pending.has(task.id) && !controller.signal.aborted) {
        controller.abort();
      }
      // contextId referenced for parity with base executor; unused here.
      void contextId;
    }
  }

  private async *_runInnerStream(
    task: Task,
    message: Message,
    priorReceipts: X402SettleResponse[],
  ): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    const session = await this.runner.createSession();
    const controller = new AbortController();
    const rawIterator = this.runner
      .runAsync(session, message, controller.signal)
      [Symbol.asyncIterator]();

    const textArtifactId = `artifact-${task.id}`;
    const textParts: string[] = [];

    task.status = {
      state: TaskState.WORKING,
      timestamp: new Date().toISOString(),
    };
    const contextId = task.contextId ?? task.id;
    yield { taskId: task.id, contextId, status: task.status };

    yield* this._driveStream(
      task,
      rawIterator,
      session,
      controller,
      textArtifactId,
      textParts,
      priorReceipts,
    );
  }

  private async *_driveStream(
    task: Task,
    iterator: AsyncIterator<AgentEvent>,
    session: Session,
    controller: AbortController,
    textArtifactId: string,
    textParts: string[],
    priorReceipts: X402SettleResponse[],
  ): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    const contextId = task.contextId ?? task.id;
    try {
      while (true) {
        const { value: event, done } = await iterator.next();
        if (done) break;

        switch (event.type) {
          case 'text': {
            textParts.push(event.text);
            yield {
              taskId: task.id,
              contextId,
              artifact: {
                artifactId: textArtifactId,
                parts: [{ text: event.text }],
              },
              append: true,
              lastChunk: false,
            } satisfies TaskArtifactUpdateEvent;
            break;
          }
          case 'paymentRequired': {
            const outcome = await this._emitPaymentRequired(
              task,
              event,
              iterator,
              session,
              controller,
              textArtifactId,
              textParts,
              priorReceipts,
            );
            // Yield the artifact update for the challenge.
            const challengeArtifact = task.artifacts?.find(
              (a) => a.artifactId === this._pending.get(task.id)?.challengeArtifactId,
            );
            if (outcome === 'emitted' && challengeArtifact) {
              yield {
                taskId: task.id,
                contextId,
                artifact: challengeArtifact,
                append: false,
                lastChunk: true,
              } satisfies TaskArtifactUpdateEvent;
            }
            yield { taskId: task.id, contextId, status: task.status };
            return;
          }
          case 'done': {
            if (textParts.length > 0) {
              const artifact: Artifact = {
                artifactId: textArtifactId,
                parts: [{ text: textParts.join('') }],
              };
              appendArtifact(task, artifact);
              yield {
                taskId: task.id,
                contextId,
                artifact,
                append: false,
                lastChunk: true,
              } satisfies TaskArtifactUpdateEvent;
            }
            task.status = {
              state: TaskState.COMPLETED,
              timestamp: new Date().toISOString(),
            };
            if (priorReceipts.length > 0) {
              attachReceipts(task, priorReceipts);
            }
            yield {
              taskId: task.id,
              contextId,
              status: task.status,
            } satisfies TaskStatusUpdateEvent;
            return;
          }
          case 'error':
            task.status = {
              state: TaskState.FAILED,
              timestamp: new Date().toISOString(),
              message: {
                messageId: `error-${Date.now()}`,
                role: 'agent',
                parts: [{ text: event.error.message }],
              },
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
        timestamp: new Date().toISOString(),
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
      };
      yield { taskId: task.id, contextId, status: task.status };
    } finally {
      if (!this._pending.has(task.id) && !controller.signal.aborted) {
        controller.abort();
      }
    }
  }

  // ─── paymentRequired handling ──────────────────────────────────────────

  /**
   * Consume a `paymentRequired` event from the inner generator: resolve
   * its accepts, emit an artifact-shaped challenge on the task, mark the
   * task `input-required`, stash the paused iterator so the next client
   * message can resume it.
   */
  private async _emitPaymentRequired(
    task: Task,
    event: Extract<AgentEvent, { type: 'paymentRequired' }>,
    iterator: AsyncIterator<AgentEvent>,
    session: Session,
    controller: AbortController,
    textArtifactId: string,
    textParts: string[],
    priorReceipts: X402SettleResponse[],
  ): Promise<'emitted' | 'failed'> {
    const resolved = await this._resolveAcceptsForEvent(event, task);
    if (resolved.length === 0) {
      applyFailedPaymentStatus(
        task,
        X402_ERROR_CODES.NO_REQUIREMENTS,
        'Agent requested embedded payment but no requirements were resolved.',
        undefined,
      );
      try {
        await iterator.return?.(undefined);
      } catch {
        // ignore
      }
      if (!controller.signal.aborted) controller.abort();
      return 'failed';
    }

    const challengeArtifactId = event.artifactId ?? `x402-challenge-${Date.now()}`;
    const artifact = buildChallengeArtifact({
      artifactId: challengeArtifactId,
      name: event.artifactName ?? X402_EMBEDDED_ARTIFACT_NAME,
      metadata: event.artifactMetadata,
      accepts: resolved,
      embeddedObject: event.embeddedObject,
    });
    appendArtifact(task, artifact);

    // Per spec §5.3 the status.message.metadata MUST contain
    // `x402.payment.status: payment-required` but MUST NOT contain
    // `x402.payment.required` when Embedded is active — the payload
    // lives on an artifact.
    task.status = {
      state: TaskState.INPUT_REQUIRED,
      timestamp: new Date().toISOString(),
      message: {
        messageId: `x402-${Date.now()}`,
        role: 'agent',
        parts: [{ text: 'Payment is required to continue.' }],
        metadata: {
          [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
        },
      },
    };

    this._pending.set(task.id, {
      iterator,
      session,
      controller,
      accepts: resolved,
      challengeArtifactId,
      textArtifactId,
      textParts,
      priorReceipts,
    });

    return 'emitted';
  }

  private async _resolveAcceptsForEvent(
    event: Extract<AgentEvent, { type: 'paymentRequired' }>,
    task: Task,
  ): Promise<X402PaymentRequirements[]> {
    const inline = Array.isArray(event.accepts)
      ? (event.accepts as X402Accept[])
      : undefined;
    if (inline && inline.length > 0) {
      return inline.map(normalizeAccept);
    }

    if (this._config.resolveAccepts) {
      const dynamic = await this._config.resolveAccepts({
        task,
        message: task.status.message ?? { messageId: '', role: 'agent', parts: [] },
        embeddedObject: event.embeddedObject,
      });
      if (dynamic.length > 0) {
        return dynamic.map(normalizeAccept);
      }
    }

    return [];
  }

  // ─── Embedded resume ───────────────────────────────────────────────────

  private async _resumeEmbeddedNonStream(
    task: Task,
    message: Message,
    pending: PendingEmbeddedState,
  ): Promise<Task> {
    const status = getPaymentStatus(message);
    if (status !== X402_PAYMENT_STATUS.SUBMITTED) {
      // Client didn't actually submit payment — treat as a retry request.
      // Re-emit the challenge state so the client sees it again.
      task.status = {
        state: TaskState.INPUT_REQUIRED,
        timestamp: new Date().toISOString(),
        message: {
          messageId: `x402-${Date.now()}`,
          role: 'agent',
          parts: [{ text: 'Payment is required to continue.' }],
          metadata: {
            [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
          },
        },
      };
      return task;
    }

    const verdict = await this._verifyAndSettle(
      getPaymentPayload(message),
      pending.accepts,
    );
    if (verdict.kind === 'failure') {
      applyFailedPaymentStatus(task, verdict.code, verdict.reason, verdict.network);
      try {
        await pending.iterator.return?.(undefined);
      } catch {
        // ignore
      }
      if (!pending.controller.signal.aborted) pending.controller.abort();
      this._pending.delete(task.id);
      return task;
    }

    this._pending.delete(task.id);
    task.status = {
      state: TaskState.WORKING,
      timestamp: new Date().toISOString(),
    };
    const combinedReceipts = [...pending.priorReceipts, verdict.receipt];
    return this._driveNonStream(
      task,
      pending.iterator,
      pending.session,
      pending.controller,
      pending.textArtifactId,
      pending.textParts,
      combinedReceipts,
    );
  }

  private async *_resumeEmbeddedStream(
    task: Task,
    message: Message,
    pending: PendingEmbeddedState,
  ): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    const contextId = task.contextId ?? task.id;
    const status = getPaymentStatus(message);
    if (status !== X402_PAYMENT_STATUS.SUBMITTED) {
      task.status = {
        state: TaskState.INPUT_REQUIRED,
        timestamp: new Date().toISOString(),
        message: {
          messageId: `x402-${Date.now()}`,
          role: 'agent',
          parts: [{ text: 'Payment is required to continue.' }],
          metadata: {
            [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
          },
        },
      };
      yield { taskId: task.id, contextId, status: task.status };
      return;
    }

    const verdict = await this._verifyAndSettle(
      getPaymentPayload(message),
      pending.accepts,
    );
    if (verdict.kind === 'failure') {
      applyFailedPaymentStatus(task, verdict.code, verdict.reason, verdict.network);
      try {
        await pending.iterator.return?.(undefined);
      } catch {
        // ignore
      }
      if (!pending.controller.signal.aborted) pending.controller.abort();
      this._pending.delete(task.id);
      yield { taskId: task.id, contextId, status: task.status };
      return;
    }

    this._pending.delete(task.id);
    task.status = {
      state: TaskState.WORKING,
      timestamp: new Date().toISOString(),
    };
    yield { taskId: task.id, contextId, status: task.status };

    const combinedReceipts = [...pending.priorReceipts, verdict.receipt];
    yield* this._driveStream(
      task,
      pending.iterator,
      pending.session,
      pending.controller,
      pending.textArtifactId,
      pending.textParts,
      combinedReceipts,
    );
  }

  // ─── Verify + settle ───────────────────────────────────────────────────

  private async _verifyAndSettle(
    payload: X402PaymentPayload | undefined,
    accepts: X402PaymentRequirements[],
  ): Promise<
    | {
        kind: 'failure';
        code: X402ErrorCode;
        reason: string;
        network: string | undefined;
      }
    | { kind: 'success'; receipt: X402SettleResponse }
  > {
    const authorization = getEvmAuthorization(payload);
    if (!payload || !authorization) {
      return {
        kind: 'failure',
        code: X402_ERROR_CODES.INVALID_PAYLOAD,
        reason: 'Payment payload is missing or malformed.',
        network: payload?.network,
      };
    }

    const accepted = accepts.find(
      (req) => req.network === payload.network && req.scheme === payload.scheme,
    );
    const validationErr = validatePayloadAgainstRequirement(payload, accepted);
    if (validationErr) {
      return {
        kind: 'failure',
        code: validationErr.code,
        reason: validationErr.reason,
        network: payload.network,
      };
    }

    const verifyResult = await this._config.facilitator.verify(payload, accepted!);
    if (!verifyResult.isValid) {
      return {
        kind: 'failure',
        code: X402_ERROR_CODES.VERIFY_FAILED,
        reason: verifyResult.invalidReason ?? 'Payment verification failed.',
        network: payload.network,
      };
    }

    const settleResult = await this._config.facilitator.settle(payload, accepted!);
    if (!settleResult.success) {
      return {
        kind: 'failure',
        code: X402_ERROR_CODES.SETTLE_FAILED,
        reason: settleResult.errorReason ?? 'Payment settlement failed.',
        network: payload.network,
      };
    }

    return {
      kind: 'success',
      receipt: {
        success: true,
        transaction: settleResult.transaction ?? '',
        network: payload.network,
      },
    };
  }
}

type GateOutcome =
  | { action: 'continue'; receipt: X402SettleResponse }
  | { action: 'emit-required' }
  | { action: 'failed' };

// ─── Module-private helpers (exported under `__internal` for tests below) ───

function resolveOptions(options: X402PaymentExecutorOptions): ResolvedConfig {
  const gateAccepts = options.accepts ?? [];
  if (gateAccepts.length === 0 && !options.resolveAccepts) {
    // Purely event-driven with no dynamic resolver and no gate: require
    // callers to at least provide one path to price payments.
    if (options.requiresPayment && options.requiresPayment.length > 0) {
      // Predicate defined but nothing to charge — fall through; the
      // predicate will decide nothing ever charges.
    }
  }
  return {
    accepts: gateAccepts.map(normalizeAccept),
    facilitator: resolveFacilitator(options.facilitator),
    requiresPayment: options.requiresPayment,
    resolveAccepts: options.resolveAccepts,
  };
}

function normalizeAccept(entry: X402Accept): X402PaymentRequirements {
  return {
    scheme: entry.scheme ?? 'exact',
    network: entry.network,
    maxAmountRequired: entry.amount,
    resource: (entry.resource ?? X402_DEFAULT_RESOURCE) as X402PaymentRequirements['resource'],
    description: entry.description ?? '',
    mimeType: entry.mimeType ?? 'application/json',
    payTo: entry.payTo,
    maxTimeoutSeconds: entry.maxTimeoutSeconds ?? X402_DEFAULT_TIMEOUT_SECONDS,
    asset: entry.asset,
    extra: entry.extra ?? { name: 'USDC', version: '2' },
  } as X402PaymentRequirements;
}

function getPaymentStatus(message: Message): string | undefined {
  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  return meta[X402_METADATA_KEYS.STATUS] as string | undefined;
}

function getPaymentPayload(message: Message): X402PaymentPayload | undefined {
  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  return meta[X402_METADATA_KEYS.PAYLOAD] as X402PaymentPayload | undefined;
}

function applyPaymentRequiredStatus(
  task: Task,
  requirements: X402PaymentRequiredResponse,
): void {
  task.status = {
    state: TaskState.INPUT_REQUIRED,
    timestamp: new Date().toISOString(),
    message: {
      messageId: `x402-${Date.now()}`,
      role: 'agent',
      parts: [{ text: 'Payment is required to use this service.' }],
      metadata: {
        [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
        [X402_METADATA_KEYS.REQUIRED]: requirements,
      },
    },
  };
}

function applyFailedPaymentStatus(
  task: Task,
  code: X402ErrorCode,
  reason: string,
  network: string | undefined,
): void {
  const receipt: X402SettleResponse = {
    success: false,
    transaction: '',
    network: network ?? 'unknown',
    errorReason: reason,
  };
  task.status = {
    state: TaskState.FAILED,
    timestamp: new Date().toISOString(),
    message: {
      messageId: `x402-${Date.now()}`,
      role: 'agent',
      parts: [{ text: `Payment verification failed: ${reason}` }],
      metadata: {
        [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.FAILED,
        [X402_METADATA_KEYS.ERROR]: code,
        [X402_METADATA_KEYS.RECEIPTS]: [receipt],
      },
    },
  };
}

function attachReceipts(task: Task, receipts: X402SettleResponse[]): void {
  if (!task.status.message) {
    task.status.message = {
      messageId: `x402-${Date.now()}`,
      role: 'agent',
      parts: [{ text: '' }],
      metadata: {},
    };
  }
  const existing = (task.status.message.metadata ?? {}) as Record<string, unknown>;
  task.status.message.metadata = {
    ...existing,
    [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.COMPLETED,
    [X402_METADATA_KEYS.RECEIPTS]: receipts,
  };
}

function buildChallengeArtifact(input: {
  artifactId: string;
  name: string;
  metadata?: Record<string, unknown>;
  accepts: X402PaymentRequirements[];
  embeddedObject?: unknown;
}): Artifact {
  const required: X402PaymentRequiredResponse = {
    x402Version: 1,
    accepts: input.accepts,
  };
  // If the caller provided a higher-level wrapper (e.g. an AP2 CartMandate),
  // embed the x402 challenge alongside it at the well-known key; otherwise
  // emit a bare wrapper.
  const data =
    input.embeddedObject && typeof input.embeddedObject === 'object'
      ? {
          ...(input.embeddedObject as Record<string, unknown>),
          [X402_EMBEDDED_DATA_KEY]: required,
        }
      : { [X402_EMBEDDED_DATA_KEY]: required };

  return {
    artifactId: input.artifactId,
    name: input.name,
    parts: [{ data }],
    ...(input.metadata ? { metadata: input.metadata } : {}),
  };
}

function appendArtifact(task: Task, artifact: Artifact): void {
  const existing = task.artifacts ?? [];
  const idx = existing.findIndex((a) => a.artifactId === artifact.artifactId);
  if (idx >= 0) {
    existing[idx] = artifact;
    task.artifacts = existing;
  } else {
    task.artifacts = [...existing, artifact];
  }
}

interface EvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/**
 * Return the EIP-3009 authorization from an EVM "exact" payload, or
 * `undefined` if the payload isn't EVM-shaped (e.g. SVM payloads don't
 * carry an `authorization` block — they carry a pre-signed transaction).
 */
function getEvmAuthorization(
  payload: X402PaymentPayload | undefined,
): EvmAuthorization | undefined {
  if (!payload) return undefined;
  const inner = payload.payload as unknown as { authorization?: EvmAuthorization };
  return inner && typeof inner === 'object' && 'authorization' in inner
    ? inner.authorization
    : undefined;
}

function validatePayloadAgainstRequirement(
  payload: X402PaymentPayload,
  accepted: X402PaymentRequirements | undefined,
): { code: X402ErrorCode; reason: string } | undefined {
  if (!accepted) {
    return {
      code: X402_ERROR_CODES.NETWORK_MISMATCH,
      reason: `Network/scheme "${payload.network}/${payload.scheme}" is not accepted.`,
    };
  }
  const authorization = getEvmAuthorization(payload);
  if (!authorization) {
    return {
      code: X402_ERROR_CODES.INVALID_PAYLOAD,
      reason: 'Non-EVM payloads are not yet supported by the SDK.',
    };
  }
  if (authorization.to.toLowerCase() !== accepted.payTo.toLowerCase()) {
    return {
      code: X402_ERROR_CODES.INVALID_PAY_TO,
      reason: `payTo mismatch: expected ${accepted.payTo}, got ${authorization.to}.`,
    };
  }
  try {
    if (BigInt(authorization.value) > BigInt(accepted.maxAmountRequired)) {
      return {
        code: X402_ERROR_CODES.AMOUNT_EXCEEDED,
        reason: `Amount ${authorization.value} exceeds maximum ${accepted.maxAmountRequired}.`,
      };
    }
  } catch {
    return {
      code: X402_ERROR_CODES.INVALID_PAYLOAD,
      reason: 'Authorization value is not a valid number.',
    };
  }
  return undefined;
}

/** @internal exported for the unit tests to exercise helper functions. */
export const __internal = {
  normalizeAccept,
  validatePayloadAgainstRequirement,
  applyPaymentRequiredStatus,
  applyFailedPaymentStatus,
  attachReceipts,
  buildChallengeArtifact,
};
