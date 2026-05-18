/**
 * `BaseX402Store` — abstract storage contract for the lifecycle record
 * of an x402 payment round-trip, keyed by `taskId`.
 *
 * On turn 1 the agent calls `X402Context.requestPayment(...)` which
 * `put`s an entry here with `status: 'offered'`. As the round-trip
 * progresses, `X402Context.classify`, `verify`, and `settle` each
 * update the entry in place — recording the new status, the verify
 * timestamp, the settlement receipt, or the failure point as
 * appropriate. The agent never has to touch the store directly.
 *
 * `InMemoryX402Store` (in this file) is the default concrete
 * implementation — sufficient for single-instance deployments and
 * local development. Production deployments with horizontal scaling
 * or a need to survive process restarts subclass `BaseX402Store` with
 * a shared external backend (Redis, Postgres, Durable Object, …).
 */

import type { X402ErrorCode } from './constants.js';
import type { X402Accept } from './types.js';

/**
 * Lifecycle status of an x402 round-trip as tracked by the
 * `BaseX402Store`. Mirrors the spec's wire `payment-*` states but
 * lives entirely in server-side state — never leaks onto the wire.
 *
 *  - `offered`   — `requestPayment` published `payment-required`. Awaiting client submission.
 *  - `verified`  — `verify(...)` succeeded. Awaiting `settle(...)`.
 *  - `completed` — `settle(...)` succeeded. `receipt` is populated.
 *  - `failed`    — Any step failed. `failure` is populated with the point + reason.
 *  - `rejected`  — Client sent `payment-rejected`. `failure.point === 'rejected-by-client'`.
 */
export type X402EntryStatus =
  | 'offered'
  | 'verified'
  | 'completed'
  | 'failed'
  | 'rejected';

/**
 * The internal receipt the store retains after a successful settlement.
 * Trimmed to the four fields needed for audit / reconciliation:
 *
 *  - `transaction` — on-chain tx hash; the canonical lookup key.
 *  - `network` — which chain settled, for multi-chain deployments.
 *  - `payer` — payer wallet address (x402-v1 §5.3.2 requires this on every receipt).
 *  - `settledAt` — wall-clock instant the SDK observed the settlement returning.
 */
export interface X402EntryReceipt {
  transaction: string;
  network: string;
  payer: string;
  settledAt: Date;
}

/**
 * Captures *where* in the lifecycle a failure occurred and what the
 * spec-conformant error code was. Populated when `status === 'failed'`
 * or `'rejected'`.
 */
export interface X402EntryFailure {
  /**
   * Lifecycle stage that produced the failure:
   *
   *  - `'classify'` — the submission was invalid before the facilitator was
   *    even called (missing offering, unmatched network/scheme, shape error).
   *  - `'verify'` — `facilitator.verify(...)` returned `isValid: false`.
   *  - `'settle'` — `facilitator.settle(...)` returned `success: false`.
   *  - `'rejected-by-client'` — the client sent `x402.payment.status: payment-rejected`.
   */
  point: 'classify' | 'verify' | 'settle' | 'rejected-by-client';
  code: X402ErrorCode;
  reason: string;
  failedAt: Date;
}

export interface X402StoreEntry {
  taskId: string;
  /** Offering the merchant advertised on turn 1. Immutable once set. */
  accepts: X402Accept[];
  /** Current lifecycle stage. Updated in place as the round-trip progresses. */
  status: X402EntryStatus;
  /** When the entry was first put. Immutable. */
  storedAt: Date;
  /** Last time `status` changed. */
  updatedAt: Date;
  /**
   * Wall-clock instant after which `get(taskId)` returns `undefined`.
   * Stores implement *lazy* expiry — there is no requirement to run a
   * background reaper, and serverless deployments shouldn't need to.
   */
  expiresAt?: Date;
  /** Populated when `status === 'verified'` or later. */
  verifiedAt?: Date;
  /** Populated when `status === 'completed'`. */
  receipt?: X402EntryReceipt;
  /** Populated when `status === 'failed'` or `'rejected'`. */
  failure?: X402EntryFailure;
}

/**
 * Partial update applied to an existing entry by the `X402Context`
 * pipeline. Subclasses receive this from `update(taskId, patch)` —
 * only the keys present on the patch should be modified; absent keys
 * must be left unchanged.
 */
export interface X402StoreEntryPatch {
  status?: X402EntryStatus;
  verifiedAt?: Date;
  receipt?: X402EntryReceipt;
  failure?: X402EntryFailure;
}

/**
 * Abstract base for x402 round-trip stores. Subclass and implement
 * `put` / `get` / `update` / `delete` to back the store with the
 * persistence layer of your choice.
 *
 * ```ts
 * class RedisX402Store extends BaseX402Store {
 *   constructor(private readonly redis: Redis) { super(); }
 *
 *   async put(entry: X402StoreEntry): Promise<void> {
 *     const ttl = entry.expiresAt
 *       ? Math.max(1, Math.ceil((entry.expiresAt.getTime() - Date.now()) / 1000))
 *       : undefined;
 *     await this.redis.set(
 *       `x402:${entry.taskId}`,
 *       JSON.stringify(entry),
 *       ttl ? { EX: ttl } : {},
 *     );
 *   }
 *
 *   async get(taskId: string): Promise<X402StoreEntry | undefined> {
 *     const raw = await this.redis.get(`x402:${taskId}`);
 *     if (!raw) return undefined;
 *     // (your impl: rehydrate Dates from ISO strings)
 *     return JSON.parse(raw) as X402StoreEntry;
 *   }
 *
 *   async update(taskId: string, patch: X402StoreEntryPatch): Promise<void> {
 *     const cur = await this.get(taskId);
 *     if (!cur) return;
 *     await this.put({ ...cur, ...patch, updatedAt: new Date() });
 *   }
 *
 *   async delete(taskId: string): Promise<void> {
 *     await this.redis.del(`x402:${taskId}`);
 *   }
 * }
 * ```
 *
 * Lazy expiry contract: `get(taskId)` MUST return `undefined` after
 * `entry.expiresAt`. Backends with native TTL (Redis EXPIRE, Postgres
 * `WHERE expires_at > now()`) satisfy this trivially; in-memory or
 * file-backed stores must check on read.
 */
export abstract class BaseX402Store {
  /** Replace or insert the entry for `taskId`. */
  abstract put(entry: X402StoreEntry): Promise<void>;
  /** Return the entry, or `undefined` when absent or expired. */
  abstract get(taskId: string): Promise<X402StoreEntry | undefined>;
  /**
   * Patch an existing entry — typically called by `X402Context` as it
   * transitions the round-trip through the lifecycle. Implementations
   * MUST set `updatedAt = new Date()` on any successful patch.
   * No-op when the entry is absent.
   */
  abstract update(taskId: string, patch: X402StoreEntryPatch): Promise<void>;
  /** Remove the entry (best-effort; no-op if absent). */
  abstract delete(taskId: string): Promise<void>;
}

export interface InMemoryX402StoreOptions {
  /**
   * Cap on the number of stored entries. When the cap is reached on
   * insert, the least-recently-accessed entry is evicted. Default:
   * unbounded.
   */
  maxEntries?: number;
}

/**
 * Default in-process implementation of `BaseX402Store`. Suitable for
 * single-instance deployments and local development.
 *
 * **Not** suitable for:
 *  - horizontally scaled deployments (each instance has its own
 *    memory, so the resume turn may hit a different instance with no
 *    record),
 *  - deployments that need offerings to survive process restarts.
 *
 * For either case, subclass `BaseX402Store` with a shared external
 * backend (Redis / Postgres / Durable Object / …).
 */
export class InMemoryX402Store extends BaseX402Store {
  private readonly _entries = new Map<string, X402StoreEntry>();
  private readonly _maxEntries?: number;

  constructor(options: InMemoryX402StoreOptions = {}) {
    super();
    this._maxEntries = options.maxEntries;
  }

  async put(entry: X402StoreEntry): Promise<void> {
    this._purgeExpired();

    if (
      this._maxEntries !== undefined &&
      this._entries.size >= this._maxEntries &&
      !this._entries.has(entry.taskId)
    ) {
      // Map iteration order is insertion order; the first key is the
      // least-recently-accessed. `get` re-inserts to refresh the order.
      const oldest = this._entries.keys().next().value;
      if (oldest !== undefined) this._entries.delete(oldest);
    }

    this._entries.delete(entry.taskId);
    this._entries.set(entry.taskId, entry);
  }

  async get(taskId: string): Promise<X402StoreEntry | undefined> {
    const entry = this._entries.get(taskId);
    if (!entry) return undefined;
    if (entry.expiresAt && entry.expiresAt.getTime() <= Date.now()) {
      this._entries.delete(taskId);
      return undefined;
    }
    // Touch for LRU.
    this._entries.delete(taskId);
    this._entries.set(taskId, entry);
    return entry;
  }

  async update(taskId: string, patch: X402StoreEntryPatch): Promise<void> {
    const cur = this._entries.get(taskId);
    if (!cur) return;
    if (cur.expiresAt && cur.expiresAt.getTime() <= Date.now()) {
      // Expired; treat as absent.
      this._entries.delete(taskId);
      return;
    }
    const next: X402StoreEntry = {
      ...cur,
      ...patch,
      updatedAt: new Date(),
    };
    // Refresh LRU position.
    this._entries.delete(taskId);
    this._entries.set(taskId, next);
  }

  async delete(taskId: string): Promise<void> {
    this._entries.delete(taskId);
  }

  /** Test/diagnostic helper — current size after purging expired entries. */
  size(): number {
    this._purgeExpired();
    return this._entries.size;
  }

  private _purgeExpired(): void {
    const now = Date.now();
    for (const [taskId, entry] of this._entries) {
      if (entry.expiresAt && entry.expiresAt.getTime() <= now) {
        this._entries.delete(taskId);
      }
    }
  }
}
