/**
 * x402 server-side façade.
 *
 * Two layers:
 *
 *  - `BaseX402Context` — abstract class declaring the workflow. Has
 *    concrete implementations for every method so subclasses can
 *    override one or two without rewriting the whole pipeline.
 *    Subclass directly when you want full control (custom store
 *    wiring, telemetry around `verify` / `settle`, bespoke
 *    classification rules, …).
 *  - `X402Context` — default concrete implementation. Wires up
 *    `InMemoryX402Store` and the Coinbase-hosted facilitator with
 *    sensible defaults. Most callers just `new X402Context({...})`
 *    and pass it to their agent.
 *
 * `BaseX402Context` bundles three pieces an x402-enabled agent always
 * needs together:
 *
 *  1. a `BaseX402Store` that tracks the full lifecycle of each
 *     round-trip (offered → verified → completed / failed / rejected),
 *     keyed by `taskId`. The store is updated automatically by every
 *     method below; the agent never has to call it directly.
 *  2. an `X402Facilitator` that runs the on-chain verify + settle dance;
 *  3. response-metadata builders that produce the right `AgentEvent`
 *     shape for each terminal lifecycle state.
 *
 * Each step exposes its own method so the agent can intercept between
 * them (audit, fraud check, reward pre-allocation, …). No method
 * bundles verify + settle.
 *
 * ```ts
 * const x402 = new X402Context({ facilitator: resolveFacilitator() });
 *
 * class MyAgent extends BaseAgent {
 *   constructor(private readonly x402: BaseX402Context) { super({ name: 'm' }); }
 *
 *   async *run(ctx) {
 *     const result = await this.x402.classify(ctx);
 *     switch (result.kind) {
 *       case 'no-submission':
 *         yield* this.x402.requestPayment(ctx, { accepts: ACCEPTS, expiresInSeconds: 600 });
 *         return;
 *       case 'rejected':
 *       case 'no-stored-offering':
 *       case 'unmatched':
 *       case 'invalid-shape':
 *         yield this.x402.failedEvent({ code: result.code, reason: result.reason });
 *         return;
 *       case 'valid':
 *         break;
 *     }
 *
 *     const verify = await this.x402.verify(ctx, result);
 *     if (!verify.isValid) {
 *       yield this.x402.failedEvent({
 *         code: mapVerifyFailureToCode(verify.invalidReason),
 *         reason: verify.invalidReason ?? 'Payment verification failed.',
 *       });
 *       return;
 *     }
 *
 *     // [insert custom logic between verify and settle]
 *
 *     const receipt = await this.x402.settle(ctx, result);
 *     if (!receipt.success) {
 *       yield this.x402.failedEvent({
 *         code: 'SETTLEMENT_FAILED',
 *         reason: receipt.errorReason ?? 'Payment settlement failed.',
 *         failureReceipt: receipt,
 *       });
 *       return;
 *     }
 *
 *     yield { type: 'text', text: 'thanks for paying' };
 *     yield this.x402.completedEvent({ receipt });
 *   }
 * }
 * ```
 */

import type { AgentEvent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';
import {
  X402_ERROR_CODES,
  X402_PAYMENT_STATUS,
  mapVerifyFailureToCode,
  type X402ErrorCode,
} from './constants.js';
import { resolveFacilitator, type FacilitatorUrlConfig } from './facilitator.js';
import {
  buildX402PaymentCompletedMetadata,
  buildX402PaymentFailedMetadata,
  normalizeX402Accept,
  parseX402PaymentSubmission,
  pickX402Requirement,
  validateX402PayloadShape,
  x402RequestPayment,
  type X402PaymentSubmission,
  type X402RequestPaymentInput,
  type X402ValidationIssue,
} from './payment.js';
import {
  BaseX402Store,
  InMemoryX402Store,
  type X402EntryFailure,
  type X402EntryReceipt,
  type X402StoreEntry,
} from './store.js';
import type {
  X402Accept,
  X402Facilitator,
  X402PaymentRequirements,
  X402SettleResponse,
  X402VerifyResponse,
} from './types.js';

// ─── Options ───

export interface X402ContextOptions {
  /**
   * Lifecycle store. Defaults to `new InMemoryX402Store()` — sufficient
   * for single-instance / non-restart-resilient deployments. Subclass
   * `BaseX402Store` (or plug an existing impl) for multi-instance
   * production deployments.
   */
  store?: BaseX402Store;
  /**
   * Facilitator running verify + settle. Accepts an already-implemented
   * `X402Facilitator`, a `FacilitatorUrlConfig` (URL + optional auth
   * header minter), or `undefined` to use the default Coinbase-hosted
   * facilitator.
   */
  facilitator?: X402Facilitator | FacilitatorUrlConfig;
}

// ─── requestPayment input ───

export interface X402ContextRequestPaymentInput extends X402RequestPaymentInput {
  /**
   * TTL on the lifecycle record stored for this task. After this window
   * the store returns `undefined` and `classify(...)` resolves to
   * `'no-stored-offering'`. Omit for no expiry (the record lives until
   * `clearOffering` is called or the store implementation evicts it).
   *
   * Choose this to match (or slightly exceed) the longest
   * `maxTimeoutSeconds` across `accepts[]`.
   */
  expiresInSeconds?: number;
}

// ─── classify result ───

/**
 * Tagged union describing what state the inbound message is in relative
 * to the merchant's stored offering. The agent switches on `kind` to
 * decide what to do next.
 *
 * On any non-`no-submission` / non-`valid` kind, `classify(...)` also
 * records the failure in the store (status: 'failed' or 'rejected',
 * with `failure.point`).
 */
export type X402Classification =
  | {
      /** No `x402.payment.*` metadata on the incoming message. First turn. */
      kind: 'no-submission';
    }
  | {
      /** Client sent `x402.payment.status: payment-rejected`. */
      kind: 'rejected';
      submission: X402PaymentSubmission;
      code: X402ErrorCode;
      reason: string;
    }
  | {
      /**
       * Client submitted a payment, but the store has no offering
       * record for this `taskId` — either we never offered, or the
       * record expired, or the server restarted. The agent SHOULD
       * treat this as a client error.
       */
      kind: 'no-stored-offering';
      submission: X402PaymentSubmission;
      code: X402ErrorCode;
      reason: string;
    }
  | {
      /**
       * Submission is structurally a `payment-submitted`, but its
       * `network`/`scheme` combination doesn't match any of the
       * advertised `accepts`.
       */
      kind: 'unmatched';
      submission: X402PaymentSubmission;
      offering: X402Accept[];
      code: X402ErrorCode;
      reason: string;
    }
  | {
      /**
       * Submission matches an offered requirement but the payload's
       * shape (payTo / amount / EVM authorization) is wrong. `issues`
       * lists every problem found so the agent can choose which are
       * fatal.
       */
      kind: 'invalid-shape';
      submission: X402PaymentSubmission;
      requirement: X402PaymentRequirements;
      issues: X402ValidationIssue[];
      /** Convenience: the first issue's code/reason for terminal flows. */
      code: X402ErrorCode;
      reason: string;
    }
  | {
      /**
       * Submission matches an offered requirement and passes local
       * shape validation. Proceed to `x402.verify(...)`.
       */
      kind: 'valid';
      submission: X402PaymentSubmission;
      requirement: X402PaymentRequirements;
    };

/** Narrowed alias for the only `X402Classification` kind that `verify` / `settle` accept. */
export type X402ValidClassification = Extract<X402Classification, { kind: 'valid' }>;

// ─── BaseX402Context ───

/**
 * Abstract façade declaring the x402 server-side workflow. Subclass
 * to wire up a different `store` / `facilitator` combination, or to
 * override individual methods (e.g. add telemetry around `verify` and
 * `settle`, customize `classify` validation rules, change the event
 * builders' metadata shape).
 *
 * Most callers don't subclass this — they instantiate `X402Context`
 * (the default concrete implementation) directly.
 */
export abstract class BaseX402Context {
  /** Lifecycle store. Subclasses provide a concrete instance. */
  abstract readonly store: BaseX402Store;
  /** Facilitator running verify + settle. Subclasses provide a concrete instance. */
  abstract readonly facilitator: X402Facilitator;

  /**
   * Persist the offering with status `'offered'` and yield the spec's
   * `request-input` event. The agent's one call site for "ask the
   * client to pay".
   */
  async *requestPayment(
    ctx: { taskId?: string },
    input: X402ContextRequestPaymentInput,
  ): AsyncGenerator<AgentEvent> {
    if (!input.accepts || input.accepts.length === 0) {
      throw new Error(
        `${this.constructor.name}.requestPayment: at least one entry in \`accepts\` is required`,
      );
    }
    const taskId = ctx.taskId;
    if (!taskId) {
      throw new Error(
        `${this.constructor.name}.requestPayment: ctx.taskId is required. The default ` +
          'AgentExecutor populates it when running under an A2A task.',
      );
    }
    const now = new Date();
    const entry: X402StoreEntry = {
      taskId,
      accepts: input.accepts,
      status: 'offered',
      storedAt: now,
      updatedAt: now,
      ...(input.expiresInSeconds !== undefined
        ? { expiresAt: new Date(now.getTime() + input.expiresInSeconds * 1000) }
        : {}),
    };
    await this.store.put(entry);
    yield* x402RequestPayment(input);
  }

  /**
   * Inspect the current turn's message and the stored offering, then
   * classify the result. The agent switches on `kind` to decide the
   * next action.
   *
   * For any non-`no-submission` / non-`valid` outcome, this method
   * also records the failure on the store entry (`status: 'failed'`
   * or `'rejected'`, with `failure.point`).
   */
  async classify(
    ctx: Pick<InvocationContext, 'taskId' | 'message'>,
  ): Promise<X402Classification> {
    if (!ctx.message) return { kind: 'no-submission' };
    const submission = parseX402PaymentSubmission(ctx.message);
    if (!submission) return { kind: 'no-submission' };

    if (submission.status === X402_PAYMENT_STATUS.REJECTED) {
      const result: X402Classification = {
        kind: 'rejected',
        submission,
        code: X402_ERROR_CODES.INVALID_PAYLOAD,
        reason: 'Client declined to pay.',
      };
      await this._recordClassifyOutcome(ctx.taskId, result);
      return result;
    }

    if (
      submission.status !== X402_PAYMENT_STATUS.SUBMITTED ||
      !submission.payload
    ) {
      const result: X402Classification = {
        kind: 'no-stored-offering',
        submission,
        code: X402_ERROR_CODES.INVALID_PAYLOAD,
        reason: 'Payment payload is missing or malformed.',
      };
      await this._recordClassifyOutcome(ctx.taskId, result);
      return result;
    }

    if (!ctx.taskId) {
      throw new Error(
        `${this.constructor.name}.classify: ctx.taskId is required. The default ` +
          'AgentExecutor populates it when running under an A2A task.',
      );
    }
    const entry = await this.store.get(ctx.taskId);
    if (!entry) {
      const result: X402Classification = {
        kind: 'no-stored-offering',
        submission,
        code: X402_ERROR_CODES.INVALID_PAYLOAD,
        reason:
          'No stored offering for this task (never offered, expired, or server restarted).',
      };
      // Nothing to write — entry doesn't exist (just looked it up).
      return result;
    }

    const requirements = entry.accepts.map(normalizeX402Accept);
    const requirement = pickX402Requirement(submission.payload, requirements);
    if (!requirement) {
      const result: X402Classification = {
        kind: 'unmatched',
        submission,
        offering: entry.accepts,
        code: X402_ERROR_CODES.NETWORK_MISMATCH,
        reason: 'Submitted network/scheme does not match any offered option.',
      };
      await this._recordClassifyOutcome(ctx.taskId, result);
      return result;
    }

    const issues = validateX402PayloadShape(submission.payload, requirement);
    if (issues.length > 0) {
      const first = issues[0]!;
      const result: X402Classification = {
        kind: 'invalid-shape',
        submission,
        requirement,
        issues,
        code: first.code,
        reason: first.reason,
      };
      await this._recordClassifyOutcome(ctx.taskId, result);
      return result;
    }

    return { kind: 'valid', submission, requirement };
  }

  /**
   * Run `facilitator.verify(...)` against the classified submission
   * and update the store status (`verified` on success, `failed` with
   * `failure.point: 'verify'` on failure).
   */
  async verify(
    ctx: { taskId?: string },
    classified: X402ValidClassification,
  ): Promise<X402VerifyResponse> {
    const result = await this.facilitator.verify(
      classified.submission.payload!,
      classified.requirement,
    );
    if (ctx.taskId) {
      if (result.isValid) {
        await this.store.update(ctx.taskId, {
          status: 'verified',
          verifiedAt: new Date(),
        });
      } else {
        await this.store.update(ctx.taskId, {
          status: 'failed',
          failure: {
            point: 'verify',
            code: mapVerifyFailureToCode(result.invalidReason),
            reason: result.invalidReason ?? 'Payment verification failed.',
            failedAt: new Date(),
          },
        });
      }
    }
    return result;
  }

  /**
   * Run `facilitator.settle(...)` against the classified submission
   * and update the store status (`completed` + receipt on success,
   * `failed` with `failure.point: 'settle'` on failure).
   *
   * Returns the result already in the wire-conformant
   * `X402SettleResponse` shape (spec §5.5). Fills the required
   * `payer` field from the EVM authorization when the facilitator
   * omits it.
   */
  async settle(
    ctx: { taskId?: string },
    classified: X402ValidClassification,
  ): Promise<X402SettleResponse> {
    const payload = classified.submission.payload!;
    const raw = await this.facilitator.settle(payload, classified.requirement);
    const receipt: X402SettleResponse = {
      success: raw.success,
      transaction: raw.transaction ?? '',
      network: payload.network,
      payer:
        classified.submission.authorization?.from ??
        (raw.payer as string | undefined) ??
        'unknown',
      ...(raw.errorReason ? { errorReason: raw.errorReason } : {}),
    };

    if (ctx.taskId) {
      const settledAt = new Date();
      if (receipt.success) {
        const stored: X402EntryReceipt = {
          transaction: receipt.transaction,
          network: receipt.network,
          payer: receipt.payer,
          settledAt,
        };
        await this.store.update(ctx.taskId, {
          status: 'completed',
          receipt: stored,
        });
      } else {
        await this.store.update(ctx.taskId, {
          status: 'failed',
          failure: {
            point: 'settle',
            code: X402_ERROR_CODES.SETTLEMENT_FAILED,
            reason: receipt.errorReason ?? 'Payment settlement failed.',
            failedAt: settledAt,
          },
        });
      }
    }

    return receipt;
  }

  /** Best-effort removal of the stored entry — call after task termination. */
  async clearOffering(ctx: { taskId?: string }): Promise<void> {
    if (!ctx.taskId) return;
    await this.store.delete(ctx.taskId);
  }

  // ─── Event helpers (sync, no store side-effects) ───

  /**
   * Build an `error` AgentEvent that terminates the task as `failed`
   * and attaches the spec-conformant failure metadata. Does NOT touch
   * the store — `classify` / `verify` / `settle` already recorded the
   * failure when it occurred.
   */
  failedEvent(input: {
    code: X402ErrorCode;
    reason: string;
    failureReceipt?: X402SettleResponse;
    priorReceipts?: X402SettleResponse[];
  }): AgentEvent {
    return {
      type: 'error',
      error: new Error(input.reason),
      metadata: buildX402PaymentFailedMetadata(input),
    };
  }

  /**
   * Build a `done` AgentEvent that terminates the task as `completed`
   * with the settlement receipt attached. Does NOT touch the store
   * — `settle` already recorded the receipt.
   */
  completedEvent(input: {
    receipt: X402SettleResponse;
    priorReceipts?: X402SettleResponse[];
  }): AgentEvent {
    return {
      type: 'done',
      metadata: buildX402PaymentCompletedMetadata(input),
    };
  }

  // ─── Module-private helpers ───

  private async _recordClassifyOutcome(
    taskId: string | undefined,
    result: X402Classification,
  ): Promise<void> {
    if (!taskId) return;
    if (result.kind === 'valid' || result.kind === 'no-submission') return;
    const failure: X402EntryFailure = {
      point: result.kind === 'rejected' ? 'rejected-by-client' : 'classify',
      code: result.code,
      reason: result.reason,
      failedAt: new Date(),
    };
    await this.store.update(taskId, {
      status: result.kind === 'rejected' ? 'rejected' : 'failed',
      failure,
    });
  }
}

// ─── X402Context (default concrete) ───

/**
 * Default concrete `BaseX402Context` — wires up `InMemoryX402Store`
 * and a resolved facilitator with sensible defaults.
 *
 * For production deployments with horizontal scaling or restart
 * resilience, pass a subclass of `BaseX402Store` (or your own
 * subclass of `BaseX402Context`) to the constructor.
 */
export class X402Context extends BaseX402Context {
  readonly store: BaseX402Store;
  readonly facilitator: X402Facilitator;

  constructor(options: X402ContextOptions = {}) {
    super();
    this.store = options.store ?? new InMemoryX402Store();
    const spec = options.facilitator;
    this.facilitator =
      spec && typeof spec === 'object' && 'verify' in spec && 'settle' in spec
        ? (spec as X402Facilitator)
        : resolveFacilitator(spec as FacilitatorUrlConfig | undefined);
  }
}
