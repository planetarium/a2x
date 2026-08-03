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
  X402_EXTENSION_URI,
  X402_FOUNDATION_EXTENSION_URI,
  X402_PAYMENT_STATUS,
  mapVerifyFailureToCode,
  type X402ErrorCode,
} from './constants.js';
import { resolveFacilitator, type FacilitatorUrlConfig } from './facilitator.js';
import {
  X402_DEFAULT_VERSION,
  X402_SUPPORTED_VERSIONS,
  isSupportedVersion,
  payloadNetwork,
  requirementAmount,
  requirementScheme,
  withRequirementAmount,
  type X402Version,
} from './versions.js';
import {
  buildX402PaymentCompletedMetadata,
  buildX402PaymentFailedMetadata,
  buildX402PaymentRequiredMetadata,
  parseAtomicAmount,
  parseX402PaymentSubmission,
  payloadAuthorizedAmount,
  pickX402Requirement,
  validateX402PayloadShape,
  withRequirementScopedPayer,
  type X402PaymentSubmission,
  type X402RequestPaymentInput,
  type X402ValidationIssue,
} from './payment.js';
import { encodeRequirementV1 } from './wire-v1.js';
import { encodeRequirementV2 } from './wire-v2.js';
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
  X402PaymentPayload,
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
  /**
   * The single x402 protocol version this server speaks, emitted verbatim as
   * the envelopes' `x402Version` field. Defaults to `1` — the version the
   * upstream `x402_a2a` reference lineage decodes; deployments whose clients
   * speak V2 (the x402 Foundation `transports-v2` wire) opt in with `2`.
   *
   * Not to be confused with the *extension spec* versions (v0.1 / v0.2) in
   * the activation URIs — those version the A2A-layer extension document,
   * not the envelope. This is a deployment-level declaration, not a
   * negotiation default: the activation channel has no way to request a
   * version (the foundation URI is version-neutral), so the server emits
   * exactly this version. The one activation signal that exists is the
   * legacy v0.2 URI, which declares a V1-only client — an `x402Version: 2`
   * server refuses to serve it (see `requestPayment`) instead of emitting
   * envelopes it cannot decode.
   */
  x402Version?: X402Version;
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
   * The single x402 protocol version this server speaks. Overridable by
   * subclasses / `X402Context` options. Defaults to
   * `X402_DEFAULT_VERSION` (**1** — see its rationale).
   */
  x402Version: X402Version = X402_DEFAULT_VERSION;

  /**
   * Persist the offering with status `'offered'` and yield the spec's
   * `request-input` event. The agent's one call site for "ask the
   * client to pay".
   */
  async *requestPayment(
    ctx: { taskId?: string; activatedExtensions?: readonly string[] },
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
    // A client that activated the legacy v0.2 URI has declared itself
    // V1-only: spec v0.2 defines V1-shaped wire structures exclusively, and
    // no document pairs that URI with V2 envelopes. A V2 server therefore
    // fails such a client fast — with a decodable, version-neutral error —
    // rather than emit V2 it cannot parse, or downgrade to a version this
    // deployment did not configure (A2A extensions: an agent "MUST NOT fall
    // back to a different version").
    if (
      this.x402Version === 2 &&
      ctx.activatedExtensions?.includes(X402_EXTENSION_URI)
    ) {
      yield this.failedEvent({
        code: X402_ERROR_CODES.INVALID_X402_VERSION,
        reason:
          `This agent speaks x402Version 2, but the activated extension ${X402_EXTENSION_URI} ` +
          `declares a V1-only client. If this client decodes V2 envelopes, activate ` +
          `${X402_FOUNDATION_EXTENSION_URI} instead.`,
      });
      return;
    }
    const x402Version = this.x402Version;
    // Encode up-front so a misconfigured offering (e.g. a CAIP-2 network with
    // no V1 bare-name mapping under a V1 offer) throws a clean configuration
    // error here — before we persist an entry that would then be unusable and
    // make the resume turn's `classify` fail too.
    const metadata = buildX402PaymentRequiredMetadata(input, { x402Version });
    const now = new Date();
    const entry: X402StoreEntry = {
      taskId,
      accepts: input.accepts,
      offeredX402Version: x402Version,
      status: 'offered',
      storedAt: now,
      updatedAt: now,
      ...(input.expiresInSeconds !== undefined
        ? { expiresAt: new Date(now.getTime() + input.expiresInSeconds * 1000) }
        : {}),
    };
    await this.store.put(entry);
    yield {
      type: 'request-input',
      metadata,
      message: input.description ?? 'Payment is required to use this service.',
    };
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

    // Reject a submission whose x402Version is unsupported, or disagrees with
    // what we offered: an unparseable `x402Version`, or a V1 payload against a
    // V2 offering (or vice versa), can never match and must fail before the
    // facilitator — with the spec's `invalid_x402_version` code, not a
    // misleading network-mismatch.
    const offeredX402Version = entry.offeredX402Version ?? 1;
    if (
      submission.x402Version === undefined ||
      submission.x402Version !== offeredX402Version
    ) {
      const submitted =
        submission.x402Version ??
        (submission.payload as { x402Version?: unknown }).x402Version;
      const result: X402Classification = {
        kind: 'unmatched',
        submission,
        offering: entry.accepts,
        code: X402_ERROR_CODES.INVALID_X402_VERSION,
        reason: `Submitted x402Version ${String(submitted)} is unsupported or does not match the offered x402Version ${offeredX402Version}.`,
      };
      await this._recordClassifyOutcome(ctx.taskId, result);
      return result;
    }

    // Normalize the stored offering to the x402Version it was published under,
    // so the requirement handed to verify/settle matches the wire version of
    // the client's payload. A codec throw (e.g. a CAIP-2 network with no
    // V1 bare-name mapping) is a server-side configuration error surfaced as a
    // clean failure rather than an unhandled exception from classify.
    let requirements: X402PaymentRequirements[];
    try {
      requirements = entry.accepts.map((a) =>
        offeredX402Version === 2 ? encodeRequirementV2(a) : encodeRequirementV1(a),
      );
    } catch (err) {
      const result: X402Classification = {
        kind: 'unmatched',
        submission,
        offering: entry.accepts,
        code: X402_ERROR_CODES.INVALID_PAYLOAD,
        reason: `Stored offering cannot be encoded for x402Version ${offeredX402Version}: ${err instanceof Error ? err.message : String(err)}`,
      };
      await this._recordClassifyOutcome(ctx.taskId, result);
      return result;
    }

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

    // Now that a requirement is matched, the payer can be read from the field
    // that requirement's scheme actually signs, rather than sniffed from
    // whichever key happens to be on the payload. A payload carrying *both* an
    // EIP-3009 `authorization` and a Permit2 `permit2Authorization` would
    // otherwise let the decoy name the payer on the receipt and in the store.
    const scoped = withRequirementScopedPayer(submission, requirement);

    // Hook runs BEFORE any store write, so a subclass that accepts a payload
    // the built-in validator rejects never has to repair a `failed` entry.
    const issues = this.validatePayloadShape(scoped.payload!, requirement);
    if (issues.length > 0) {
      const first = issues[0]!;
      const result: X402Classification = {
        kind: 'invalid-shape',
        submission: scoped,
        requirement,
        issues,
        code: first.code,
        reason: first.reason,
      };
      await this._recordClassifyOutcome(ctx.taskId, result);
      return result;
    }

    return { kind: 'valid', submission: scoped, requirement };
  }

  /**
   * Per-scheme payload shape validation, called by `classify` on the matched
   * requirement **before** anything is written to the store. Defaults to
   * `validateX402PayloadShape` (EIP-3009 for `exact`, Permit2 for `upto`).
   *
   * Override to teach the pipeline a scheme the SDK doesn't know:
   *
   * ```ts
   * class MyContext extends X402Context {
   *   protected validatePayloadShape(payload, requirement) {
   *     if (requirement.scheme === 'my-scheme') return myChecks(payload, requirement);
   *     return super.validatePayloadShape(payload, requirement);
   *   }
   * }
   * ```
   *
   * Returning an empty array makes `classify` resolve to `'valid'` and leaves
   * the entry at `offered` — no store surgery needed.
   */
  protected validatePayloadShape(
    payload: X402PaymentPayload,
    requirement: X402PaymentRequirements,
  ): X402ValidationIssue[] {
    return validateX402PayloadShape(payload, requirement);
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
    let result: X402VerifyResponse;
    try {
      result = await this.facilitator.verify(
        classified.submission.payload!,
        classified.requirement,
      );
    } catch (err) {
      // A genuine transport/schema error (not a structured `isValid:false`,
      // which the adapter already unwraps) still records a failure so the
      // store never sticks at `offered`/`verified` and the caller gets an
      // actionable negative result instead of an exception.
      const reason = err instanceof Error ? err.message : 'Facilitator verify failed.';
      if (ctx.taskId) {
        await this.store.update(ctx.taskId, {
          status: 'failed',
          failure: {
            point: 'verify',
            code: X402_ERROR_CODES.VERIFY_FAILED,
            reason,
            failedAt: new Date(),
          },
        });
      }
      return { isValid: false, invalidReason: reason };
    }
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
   * omits it (`authorization.from` for `exact`, `permit2Authorization.from`
   * for `upto`).
   *
   * Pass `opts.amountAtomic` to settle a **metered** charge — the usage-based
   * (`upto`) flow, where the payer signed an authorization up to a maximum and
   * the merchant charges only what was consumed. The requirement forwarded to
   * the facilitator is a clone with its amount replaced. See
   * `meteredRequirement` for the clamp guarantee.
   *
   * Metering an `exact` requirement **throws**: `exact` binds the signature to
   * one specific value, and facilitators reject a settle whose requirement
   * amount disagrees with the signed `authorization.value`. Failing here — not
   * after the work is done and the facilitator has rejected it — is the point.
   */
  async settle(
    ctx: { taskId?: string },
    classified: X402ValidClassification,
    opts?: {
      /**
       * Actual charge in the asset's smallest unit. Clamped down to the
       * offered amount and to the payer's signed cap; `"0"` is legal (zero
       * metered usage). Omit to settle the full offered amount.
       */
      amountAtomic?: string;
    },
  ): Promise<X402SettleResponse> {
    const payload = classified.submission.payload!;
    const requirement =
      opts?.amountAtomic === undefined
        ? classified.requirement
        : this.meteredRequirement(
            classified.requirement,
            payload,
            opts.amountAtomic,
          );
    let raw: Awaited<ReturnType<X402Facilitator['settle']>>;
    try {
      raw = await this.facilitator.settle(payload, requirement);
    } catch (err) {
      // A settle exception (transport/schema error, possibly after the
      // transfer was broadcast) must not leave the entry stuck at `verified`
      // with no record. Mark it failed and return a negative receipt.
      const reason = err instanceof Error ? err.message : 'Facilitator settle failed.';
      if (ctx.taskId) {
        await this.store.update(ctx.taskId, {
          status: 'failed',
          failure: {
            point: 'settle',
            code: X402_ERROR_CODES.SETTLEMENT_FAILED,
            reason,
            failedAt: new Date(),
          },
        });
      }
      return {
        success: false,
        transaction: '',
        network: payloadNetwork(payload) || requirement.network,
        ...(classified.submission.payer
          ? { payer: classified.submission.payer }
          : {}),
        errorReason: reason,
      };
    }
    // The submitted authorization is authoritative on who paid — it is what
    // the signature commits to — so it wins over the facilitator's echo.
    const payer =
      classified.submission.payer ?? (raw.payer as string | undefined);
    const receipt: X402SettleResponse = {
      success: raw.success,
      transaction: raw.transaction ?? '',
      // V1 carries `network` top-level; V2 reads it from `accepted`. A V2
      // payload with no `accepted` echo cannot name a network, so fall back
      // to the matched requirement — already encoded for the offered
      // version by `classify`, hence in the right per-version form.
      network: payloadNetwork(payload) || requirement.network,
      // Omit `payer` when neither the authorization nor the facilitator
      // supplies it — never fabricate a placeholder address.
      ...(payer ? { payer } : {}),
      ...(raw.errorReason ? { errorReason: raw.errorReason } : {}),
      // V2 facilitators report what was actually settled, which can be less
      // than the signed authorization under usage-based schemes — pass it
      // through whenever the facilitator's response body carries it (success
      // or a structured `success: false` result). A non-2xx failure surfaces
      // as a thrown `SettleError` whose constructor drops `amount` upstream
      // in `@x402/core`, so the exception path above cannot recover it.
      // V1 facilitators never set it.
      ...(raw.amount !== undefined ? { amount: raw.amount } : {}),
    };

    if (ctx.taskId) {
      const settledAt = new Date();
      if (receipt.success) {
        const stored: X402EntryReceipt = {
          transaction: receipt.transaction,
          network: receipt.network,
          ...(receipt.payer ? { payer: receipt.payer } : {}),
          // Only the facilitator-confirmed amount. Under a usage-based scheme
          // this is the key reconciliation datum and is not recoverable from
          // `entry.accepts` (which holds the authorized maximum) — but what we
          // *asked* to settle is not evidence of what settled, so when the
          // facilitator omits it the key stays absent rather than recording an
          // inference as fact.
          ...(receipt.amount !== undefined ? { amount: receipt.amount } : {}),
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

  /**
   * Clone `requirement` with its amount replaced by the metered charge,
   * clamped down to the minimum of:
   *
   *  1. `amountAtomic` — what the merchant metered;
   *  2. the offered requirement's amount — the merchant's own advertised cap;
   *  3. the payer's signed authorization cap
   *     (`permit2Authorization.permitted.amount` for `upto`,
   *     `authorization.value` for `exact`), when the payload names one.
   *
   * The clamp lives in the SDK on purpose: a merchant metering bug (an
   * off-by-a-decimal token count, a stale price table) can then only ever
   * *undercharge*. The facilitator enforces the same bound on-chain — this is
   * defence in depth, not a substitute for it.
   *
   * Writes whichever amount field the requirement's encoded version uses
   * (`maxAmountRequired` under V1, `amount` under V2). Comparison is BigInt,
   * so 30-digit atomic values are exact.
   *
   * Throws when `amountAtomic` is not a plain decimal integer string. Bare
   * `BigInt` would accept `''` as zero and `'0x10'` as sixteen — an empty
   * meter reading silently settling nothing, or a hex string settling 16× the
   * intended charge, is precisely what the clamp exists to prevent.
   *
   * Also throws when the requirement's scheme is `exact`: that scheme binds
   * the signature to one value, so a facilitator rejects any settle whose
   * amount disagrees with it. Failing fast beats discovering it after the work
   * is already done.
   */
  protected meteredRequirement(
    requirement: X402PaymentRequirements,
    payload: X402PaymentPayload,
    amountAtomic: string,
  ): X402PaymentRequirements {
    if (requirementScheme(requirement) === 'exact') {
      throw new Error(
        `${this.constructor.name}.settle: metered settlement requires a usage-based scheme; ` +
          `the matched requirement uses "exact", which binds the payer's signature to a ` +
          `single amount. Offer scheme "upto" to charge a metered amount.`,
      );
    }
    const metered = parseAtomicAmount(amountAtomic);
    if (metered === undefined) {
      throw new Error(
        `${this.constructor.name}.settle: amountAtomic must be a decimal integer string in ` +
          `the asset's smallest unit (no sign, hex, or whitespace), got ` +
          `${JSON.stringify(amountAtomic)}`,
      );
    }

    const bounds: bigint[] = [metered];
    const offered = parseAtomicAmount(requirementAmount(requirement));
    if (offered === undefined) {
      // Came from our own encoded offering — a configuration error, not a
      // client one, and silently skipping the bound would drop a clamp.
      throw new Error(
        `${this.constructor.name}.settle: the matched requirement's amount ` +
          `${JSON.stringify(requirementAmount(requirement))} is not a decimal integer string.`,
      );
    }
    bounds.push(offered);
    // A non-decimal cap is client-controlled garbage that shape validation
    // already rejects; skip it rather than let it raise the ceiling.
    const signedCap = parseAtomicAmount(payloadAuthorizedAmount(payload));
    if (signedCap !== undefined) bounds.push(signedCap);

    const clamped = bounds.reduce((a, b) => (a < b ? a : b));
    return withRequirementAmount(requirement, clamped.toString());
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
    if (options.x402Version !== undefined) {
      // Fail fast on a misconfigured version (reachable from plain JS or
      // `any`): silently proceeding would encode V1 while persisting the
      // bogus value as `offeredX402Version`, making every later submission
      // fail `classify` with a misleading `invalid_x402_version`.
      if (!isSupportedVersion(options.x402Version)) {
        throw new Error(
          `X402Context: unsupported x402Version ${String(options.x402Version)} — supported versions: ${X402_SUPPORTED_VERSIONS.join(', ')}`,
        );
      }
      this.x402Version = options.x402Version;
    }
    const spec = options.facilitator;
    this.facilitator =
      spec && typeof spec === 'object' && 'verify' in spec && 'settle' in spec
        ? (spec as X402Facilitator)
        : resolveFacilitator(spec as FacilitatorUrlConfig | undefined);
  }
}
