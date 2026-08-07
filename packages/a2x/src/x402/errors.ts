/**
 * x402-specific error types. Thrown client-side by `A2XClient` (when
 * its `x402` option is configured) and the `signX402Payment` primitive
 * when the server or the x402 flow itself produces something unactionable.
 *
 * Server-side the SDK doesn't throw — it emits a `payment-failed` task
 * status with an error code under `x402.payment.error`.
 */

import type { X402ErrorCode } from './constants.js';
// Type-only, erased at runtime — no import cycle with client.ts.
import type { X402BatchSettlementBinding } from './client.js';

export class X402Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'X402Error';
  }
}

export class X402PaymentRequiredError extends X402Error {
  constructor(message: string = 'Payment is required but no signer is configured') {
    super(message);
    this.name = 'X402PaymentRequiredError';
  }
}

export class X402PaymentFailedError extends X402Error {
  readonly code: X402ErrorCode | string;
  readonly transaction?: string;
  readonly network?: string;

  constructor(
    message: string,
    code: X402ErrorCode | string,
    details?: { transaction?: string; network?: string },
  ) {
    super(message);
    this.name = 'X402PaymentFailedError';
    this.code = code;
    this.transaction = details?.transaction;
    this.network = details?.network;
  }
}

export class X402NoSupportedRequirementError extends X402Error {
  constructor(message: string = 'No payment requirement in the server response matches the configured signer') {
    super(message);
    this.name = 'X402NoSupportedRequirementError';
  }
}

/**
 * Thrown when an optional x402 peer dependency isn't installed.
 *
 * `@x402/core` / `@x402/evm` are optional peers loaded lazily on the first
 * sign / verify / settle, so a missing peer would otherwise surface as a raw
 * `ERR_MODULE_NOT_FOUND` in the middle of a payment round-trip — long after
 * install, typecheck, and startup all passed. This names the packages to
 * install instead, and calls out the peer rename for anyone upgrading.
 */
export class X402PeerMissingError extends X402Error {
  /** Bare package name that failed to resolve (e.g. `@x402/core`). */
  readonly packageName: string;
  /** Full specifier the SDK tried to import (e.g. `@x402/core/http`). */
  readonly specifier: string;

  constructor(specifier: string, packageName: string, options?: { cause?: unknown }) {
    super(
      `Cannot load "${packageName}", required for x402 payments. ` +
        'Install the optional peer dependencies:\n' +
        '  npm install @x402/core @x402/evm viem\n' +
        'Upgrading from @a2x/sdk 0.15 or earlier? The signing and facilitator ' +
        'runtime moved from `x402` to `@x402/core` + `@x402/evm`.',
    );
    this.name = 'X402PeerMissingError';
    this.packageName = packageName;
    this.specifier = specifier;
    if (options && 'cause' in options) {
      // Preserve the original resolution error for debugging without
      // depending on the ES2022 `cause` constructor option.
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Thrown when a `batch-settlement` payment settled but its receipt could not
 * be folded back into channel storage.
 *
 * This is a funds-bearing failure, not a bookkeeping one. The merchant
 * requires the next voucher's cumulative to equal exactly `charged + amount`,
 * and `@x402/evm`'s corrective-recovery path needs a signer with
 * `readContract` — which a viem `LocalAccount` does not have. So a channel
 * whose receipt was lost stays desynced until its storage is repaired out of
 * band, and the next call can sign a **fresh on-chain deposit**. Continuing
 * silently would deny the operator the one chance to quarantine the channel
 * before that happens.
 *
 * `task` carries the merchant's completed task, so a caller that catches this
 * still has the result it paid for. Configure `A2XClientX402Options`'
 * `onReconcileError` to record and continue instead of throwing.
 */
export class X402ReconciliationError extends X402Error {
  /** Channel whose local state is now stale. */
  readonly channelId: string;
  /** The terminal task, when one arrived before reconciliation failed. */
  readonly task?: unknown;
  /**
   * The quarantined attempt's complete binding — channel, voucher ceiling,
   * deposit, and the trusted pre-attempt snapshot. This is the repair fold's
   * input: pass it as `reconcileX402BatchSettlement`'s `bindings` together
   * with the receipt (from `task`, or fetched via `tasks/get` on `taskId`)
   * to restore the channel and clear its quarantine marker. Without it the
   * snapshot cannot be reconstructed after the fact.
   */
  readonly binding?: X402BatchSettlementBinding;
  /**
   * Id of the A2A task the attempt paid. On failures with no terminal
   * `task` — a transport error after submission, a closed stream — this is
   * the only handle for fetching the settled receipt via `tasks/get`; the
   * high-level client consumed the `payment-required` task internally, so
   * the caller never saw the id anywhere else.
   */
  readonly taskId?: string;
  /**
   * Why the state did not move.
   *
   * `write-failed` — the storage backend threw. Usually transient.
   *
   * `no-matching-receipt` — the payment settled but nothing was written,
   * because the merchant returned no receipt for the channel this payment
   * signed, named a different channel, or reported a cumulative the binding
   * cannot vouch for. Unlike a write failure this can be the merchant
   * misbehaving, not infrastructure.
   *
   * `ambiguous-response` — the signed submission was sent, but the transport,
   * parser, or SSE stream ended before a usable receipt or terminal retry
   * response arrived. The merchant may still hold a spendable voucher.
   */
  readonly reason:
    | 'write-failed'
    | 'no-matching-receipt'
    | 'ambiguous-response';

  constructor(
    channelId: string,
    task?: unknown,
    options?: {
      cause?: unknown;
      reason?:
        | 'write-failed'
        | 'no-matching-receipt'
        | 'ambiguous-response';
      binding?: X402BatchSettlementBinding;
      taskId?: string;
    },
  ) {
    const reason = options?.reason ?? 'write-failed';
    super(
      (reason === 'no-matching-receipt'
        ? `Settled a batch-settlement payment on channel ${channelId} but no usable receipt came back for it ` +
          '(none returned, a different channel named, or a cumulative above what the voucher authorized). '
        : reason === 'ambiguous-response'
          ? `Submitted a batch-settlement payment on channel ${channelId}, but the response ended before a usable receipt arrived. ` +
            'The merchant may still hold the spendable voucher. '
          : `Settled a batch-settlement payment but failed to record the receipt for channel ${channelId}. `) +
        'Local channel state is now stale: the next payment on this channel will be rejected for a ' +
        'cumulative mismatch, or will open a fresh on-chain deposit. Repair the channel record before reusing it.',
    );
    this.name = 'X402ReconciliationError';
    this.channelId = channelId;
    this.task = task;
    this.binding = options?.binding;
    this.taskId = options?.taskId;
    this.reason = reason;
    if (options && 'cause' in options) {
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Thrown when signing selected a `batch-settlement` channel whose stored
 * state carries a quarantine marker (`X402ChannelState.quarantinedAt`).
 *
 * The SDK writes that marker when an attempt on the channel ended without a
 * trustworthy reconciliation — the voucher may be spent, or a receipt may
 * have been lost — so the next signature could authorize a duplicate
 * deposit. Unlike the in-process abort that `X402ReconciliationError`
 * propagates to queued attempts, the marker survives a process restart.
 *
 * Recovery: the stored marker carries its own repair inputs —
 * `quarantineBinding` (the attempt's complete binding, snapshot included)
 * and `quarantineTaskId` (the paid task, whose receipt `tasks/get` returns).
 * Re-running `reconcileX402BatchSettlement` with that pair clears the marker
 * on a successful fold — or remove the marker manually once the state is
 * verified.
 */
export class X402ChannelQuarantinedError extends X402Error {
  /** Channel whose stored state is marked quarantined. */
  readonly channelId: string;
  /** When the marker was written (ISO 8601). */
  readonly quarantinedAt: string;
  /** The `X402ReconciliationError` reason recorded with the marker, if any. */
  readonly quarantineReason?: string;

  constructor(
    channelId: string,
    quarantinedAt: string,
    quarantineReason?: string,
  ) {
    super(
      `batch-settlement channel ${channelId} was quarantined at ${quarantinedAt}` +
        (quarantineReason ? ` (${quarantineReason})` : '') +
        '. A previous attempt ended without a trustworthy reconciliation, so signing ' +
        'again could authorize a duplicate deposit. Repair the channel record ' +
        '(or clear the quarantine marker after verifying it) before reusing the channel.',
    );
    this.name = 'X402ChannelQuarantinedError';
    this.channelId = channelId;
    this.quarantinedAt = quarantinedAt;
    this.quarantineReason = quarantineReason;
  }
}

/**
 * Thrown when the merchant claims an `x402Version` the SDK can't speak.
 * a2x supports x402Version 1 and 2. The wire `code` matches the spec's
 * `invalid_x402_version` token verbatim — a2a-x402 v0.2 §9.1 doesn't
 * redefine this code (it only enumerates seven UPPERCASE codes none of
 * which apply here), so x402-v1's lowercase spelling is the authoritative
 * wire form.
 */
export class X402InvalidVersionError extends X402Error {
  readonly version: number;
  readonly code = 'invalid_x402_version';

  constructor(version: number) {
    super(
      `Unsupported x402Version ${version}; this SDK speaks x402Version 1 and 2.`,
    );
    this.name = 'X402InvalidVersionError';
    this.version = version;
  }
}
