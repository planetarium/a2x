/**
 * The client-side lifecycle of one `batch-settlement` payment attempt.
 *
 * `batch-settlement` is a stateful, funds-moving protocol: every missed
 * lifecycle exit can become a duplicate on-chain deposit rather than an
 * ordinary bookkeeping error. This module therefore represents one attempt as
 * an explicit object with a single, idempotent resolution — instead of
 * scattering the safety-critical state across control-flow branches of the
 * blocking and streaming request paths.
 *
 * One attempt's life:
 *
 * ```
 * lease acquired → signed (binding + trusted pre-attempt snapshot captured)
 *   → submitted → exactly one of:
 *        reconciled   — matching receipt folded into storage
 *        retryable    — merchant rejected the voucher with a valid re-prompt
 *        quarantined  — any exit that cannot prove the voucher is unspent
 * ```
 *
 * Every response path — terminal metadata, retry prompt, transport failure,
 * EOF, consumer-driven iterator close — resolves the attempt through the
 * same three methods (`observe`, `acceptRetry`, `close`), each of which is a
 * no-op once the attempt is resolved. `dispose` is the last-resort release
 * for exits before submission.
 *
 * @internal Not part of `@a2x/sdk`'s public surface — `A2XClient` drives it.
 */

import type { Task } from '../types/task.js';
import { TERMINAL_STATES } from '../types/task.js';
import {
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
} from './constants.js';
import {
  X402PaymentRequiredError,
  X402ReconciliationError,
} from './errors.js';
import {
  reconcileX402BatchSettlement,
  type X402BatchSettlementBinding,
  type X402ClientChannelStorage,
} from './client.js';
import type { X402SettleResponse } from './types.js';

// The peer does not persist provisional state while it signs, so two payloads
// produced from the same storage snapshot can each carry a fresh deposit. The
// channel id is only available after that unsafe signing step; serialize by
// storage identity instead, from before signing until receipt reconciliation
// or quarantine completes. Module scope makes the guard span A2XClient
// instances that share the same storage object.
const _batchAttemptQueues = new WeakMap<
  X402ClientChannelStorage,
  Promise<X402ReconciliationError | undefined>
>();

/**
 * Acquire the full-attempt lease for `storage`. Resolves once every earlier
 * attempt on the same storage object has resolved; throws the predecessor's
 * quarantine error instead of letting this attempt sign from the same stale
 * snapshot the unsafe outcome invalidated.
 */
export async function acquireBatchAttemptLock(
  storage: X402ClientChannelStorage,
): Promise<(error?: X402ReconciliationError) => void> {
  if (
    typeof storage !== 'object' ||
    storage === null ||
    typeof (storage as { get?: unknown }).get !== 'function' ||
    typeof (storage as { set?: unknown }).set !== 'function' ||
    typeof (storage as { delete?: unknown }).delete !== 'function'
  ) {
    throw new X402PaymentRequiredError(
      'batchSettlement.storage must provide callable get, set, and delete methods; ' +
        'the SDK does not fall back to in-memory channel storage.',
    );
  }

  const previous =
    _batchAttemptQueues.get(storage) ?? Promise.resolve(undefined);
  let unlock!: (error?: X402ReconciliationError) => void;
  const current = new Promise<X402ReconciliationError | undefined>((resolve) => {
    unlock = resolve;
  });
  _batchAttemptQueues.set(storage, current);

  const previousError = await previous;
  if (previousError) {
    // Every waiter registered before the unsafe outcome must observe it
    // instead of signing from the same stale storage snapshot. Passing the
    // error through this queue node also aborts waiters already chained behind
    // this one; a later explicit retry can start after the queue drains and the
    // operator has repaired or retired the channel.
    unlock(previousError);
    if (_batchAttemptQueues.get(storage) === current) {
      _batchAttemptQueues.delete(storage);
    }
    throw previousError;
  }
  let released = false;
  return (error?: X402ReconciliationError) => {
    if (released) return;
    released = true;
    unlock(error);
    if (_batchAttemptQueues.get(storage) === current) {
      _batchAttemptQueues.delete(storage);
    }
  };
}

/**
 * One in-flight `batch-settlement` attempt: the signed binding, the storage
 * it must be reconciled into, the lease that keeps other attempts off that
 * storage, and the single idempotent resolution every exit path funnels into.
 *
 * Failure is **not** swallowed. The server requires the next voucher's
 * cumulative to equal exactly `charged + amount`, and `@x402/evm`'s self-heal
 * path needs a signer with `readContract`, which a viem `LocalAccount` does
 * not have — so a missed receipt leaves the channel desynced until its
 * storage is repaired out of band, and the next call can sign a fresh real
 * deposit. An operator who never hears about it cannot stop that. The error
 * carries the completed task so the caller keeps its result either way; the
 * `onReconcileError` handler records it without throwing.
 */
export class X402BatchAttempt {
  readonly binding: X402BatchSettlementBinding;
  private readonly _storage: X402ClientChannelStorage;
  private readonly _release: (error?: X402ReconciliationError) => void;
  private readonly _onReconcileError?: (
    error: X402ReconciliationError,
  ) => void | Promise<void>;
  private _resolved = false;

  constructor(options: {
    binding: X402BatchSettlementBinding;
    storage: X402ClientChannelStorage;
    release: (error?: X402ReconciliationError) => void;
    onReconcileError?: (
      error: X402ReconciliationError,
    ) => void | Promise<void>;
  }) {
    this.binding = options.binding;
    this._storage = options.storage;
    this._release = options.release;
    this._onReconcileError = options.onReconcileError;
  }

  /**
   * Classify one response (a blocking result or a single stream event)
   * against this attempt.
   *
   * Returns `true` when the attempt is now resolved — its receipt folded, or
   * its failure absorbed by `onReconcileError` — and `false` while the
   * response may legitimately still be intermediate (`payment-verified`,
   * plain `working`). Only a settled payment owes a receipt: once the task
   * reaches a terminal state or carries the `payment-completed` marker, a
   * missing/foreign/inflated receipt quarantines the channel, because the
   * merchant may hold the voucher while local state did not move.
   *
   * An attempt exists **only for an exchange this client paid with a
   * voucher**, which is itself a trust boundary. The storage key is the
   * merchant-supplied `channelState.channelId`, and channel ids derive from
   * public inputs, so any agent could compute the one this payer shares with
   * a *different* merchant. Folding receipts from every response would let
   * an agent this payer merely messaged plant a bogus cumulative for someone
   * else's channel — bricking it, or forcing an inflated voucher and top-up.
   * The fold is additionally bound to this attempt's channel, so the paid
   * merchant can update only the channel it was actually paid through.
   *
   * Throws `X402ReconciliationError` on quarantine when no
   * `onReconcileError` handler is configured; the lease is released (carrying
   * the error to queued attempts) either way.
   */
  async observe(
    metadata: Record<string, unknown> | undefined,
    task: Task | undefined,
  ): Promise<boolean> {
    if (this._resolved) return true;

    const receiptRequired =
      metadata?.[X402_METADATA_KEYS.STATUS] === X402_PAYMENT_STATUS.COMPLETED ||
      (task !== undefined && TERMINAL_STATES.has(task.status.state));
    const receipts = metadata?.[X402_METADATA_KEYS.RECEIPTS];
    const list = Array.isArray(receipts)
      ? (receipts as X402SettleResponse[])
      : [];
    if (!receiptRequired && list.length === 0) return false;

    let applied: string[] = [];
    let cause: unknown;
    try {
      ({ applied } = await reconcileX402BatchSettlement(list, {
        storage: this._storage,
        bindings: this.binding,
      }));
    } catch (err) {
      cause = err;
    }

    if (cause === undefined && applied.length > 0) {
      this._resolved = true;
      this._release();
      return true;
    }
    if (cause === undefined && !receiptRequired) return false;

    // Nothing written on a settled payment is a failure, not a no-op: the
    // voucher is spent and local state did not move, so the next call either
    // re-signs the same voucher or opens a fresh on-chain deposit. This is the
    // case where the merchant returned no receipt, a foreign channel, or a
    // cumulative above what we authorized — silence there is exactly what the
    // error exists to prevent.
    await this._quarantine(
      cause === undefined ? 'no-matching-receipt' : 'write-failed',
      task,
      cause,
    );
    return true;
  }

  /**
   * A valid `payment-required` re-prompt arrived: the merchant provably
   * rejected this attempt's voucher, so the channel is safe to release for
   * the next signing attempt. No-op once resolved — a receipt already
   * applied wins over a later contradictory prompt, since the voucher was
   * accepted and signing again would authorize the same call twice.
   */
  acceptRetry(): void {
    if (this._resolved) return;
    this._resolved = true;
    this._release();
  }

  /**
   * The response ended without proving either outcome — transport or parse
   * failure after submission, SSE stream EOF, abort, or the consumer closing
   * the iterator on (or before) the final event. The merchant may hold a
   * spendable voucher, so an unresolved attempt quarantines here. No-op once
   * resolved, which is what lets every exit path call it unconditionally.
   */
  async close(
    context: { task?: Task; cause?: unknown } = {},
  ): Promise<void> {
    if (this._resolved) return;
    await this._quarantine('ambiguous-response', context.task, context.cause);
  }

  /**
   * Release the lease for an attempt whose payload never reached the
   * merchant (e.g. building the follow-up request threw). Nothing was
   * submitted, so no funds can be at risk and the release carries no error.
   */
  dispose(): void {
    if (this._resolved) return;
    this._resolved = true;
    this._release();
  }

  private async _quarantine(
    reason: 'no-matching-receipt' | 'write-failed' | 'ambiguous-response',
    task: Task | undefined,
    cause: unknown,
  ): Promise<void> {
    this._resolved = true;
    const error = new X402ReconciliationError(this.binding.channelId, task, {
      cause,
      reason,
    });

    // Persist the quarantine before releasing the lease, so the block
    // outlives this process: the in-memory queue below stops attempts already
    // waiting, but a restart would otherwise sign a fresh deposit from the
    // same desynced storage. Best-effort — when storage itself is the thing
    // failing, the in-memory abort and the surfaced error still stand.
    try {
      const key = this.binding.channelId.toLowerCase();
      const current =
        (await this._storage.get(key)) ?? this.binding.preAttemptState;
      await this._storage.set(key, {
        ...(current ?? {}),
        quarantinedAt: new Date().toISOString(),
        quarantineReason: reason,
      });
    } catch {
      // Marker write is advisory; the error path below is the guarantee.
    }

    // Releasing the full-attempt lease must carry this unsafe outcome to calls
    // that are already queued on the same storage object. Otherwise the next
    // waiter signs from the unchanged snapshot and can authorize a duplicate
    // deposit before the operator has a chance to quarantine the channel.
    this._release(error);

    if (!this._onReconcileError) throw error;
    await this._onReconcileError(error);
  }
}
