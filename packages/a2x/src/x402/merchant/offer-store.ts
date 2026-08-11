import type { MerchantOffer } from './types.js';

export interface MerchantOfferStore {
  /**
   * Serialize publishers for a task and bind the frozen terms to the SDK's
   * offering write performed inside `publish`.
   */
  publishing<T>(
    taskId: string,
    offer: MerchantOffer,
    publish: (frozenOffer: MerchantOffer) => Promise<T>,
  ): Promise<T>;
  getOffer(taskId: string): Promise<MerchantOffer | undefined>;
  /**
   * Optional read-only replay hint. `claim()` remains the atomic arbiter:
   * callers must not grant execution based on an `available` read.
   */
  getClaimStatus?(
    taskId: string,
  ): Promise<MerchantOfferClaimStatus | undefined>;
  /** Atomically grants one caller the right to act on the submitted payment. */
  claim(taskId: string): Promise<boolean>;
  /** Releases a claim when a retryable scheme cancels verified resource work. */
  release(taskId: string): Promise<void>;
  /**
   * Remove only merchant terms when the implementation also stores lifecycle state.
   * Required when the same object is supplied as both stores and completed lifecycle
   * entries are retained.
   */
  deleteOffer?(taskId: string): Promise<void>;
  delete(taskId: string): Promise<void>;
}

export type MerchantOfferClaimStatus = 'available' | 'claimed';

export interface InMemoryMerchantOfferStoreOptions {
  /** Maximum live entries. Defaults to 10,000. */
  maxEntries?: number;
  /** TTL applied when an offer omits expiresInSeconds. Defaults to 600 seconds. */
  defaultTtlSeconds?: number;
}

interface InMemoryEntry {
  offer: MerchantOffer;
  claimed: boolean;
  expiresAt?: number;
}

function cloneOffer(offer: MerchantOffer): MerchantOffer {
  return structuredClone(offer);
}

/** Single-process default. Multi-replica deployments need an atomic shared implementation. */
export class InMemoryMerchantOfferStore implements MerchantOfferStore {
  private readonly entries = new Map<string, InMemoryEntry>();
  private readonly queues = new Map<string, Promise<void>>();
  private readonly maxEntries: number;
  private readonly defaultTtlSeconds: number;

  constructor(options: InMemoryMerchantOfferStoreOptions = {}) {
    const maxEntries = options.maxEntries ?? 10_000;
    const defaultTtlSeconds = options.defaultTtlSeconds ?? 600;
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error('InMemoryMerchantOfferStore.maxEntries must be a positive integer.');
    }
    if (!Number.isFinite(defaultTtlSeconds) || defaultTtlSeconds <= 0) {
      throw new Error(
        'InMemoryMerchantOfferStore.defaultTtlSeconds must be greater than zero.',
      );
    }
    this.maxEntries = maxEntries;
    this.defaultTtlSeconds = defaultTtlSeconds;
  }

  async publishing<T>(
    taskId: string,
    offer: MerchantOffer,
    publish: (frozenOffer: MerchantOffer) => Promise<T>,
  ): Promise<T> {
    return this.withTaskLock(taskId, async () => {
      this.purgeExpired();
      const current = this.liveEntry(taskId);
      const created = current === undefined;
      const entry =
        current ??
        ({
          offer: cloneOffer(offer),
          claimed: false,
          expiresAt:
            Date.now() + (offer.expiresInSeconds ?? this.defaultTtlSeconds) * 1_000,
        } satisfies InMemoryEntry);

      if (created) {
        this.evictForInsert(taskId);
        this.entries.set(taskId, entry);
      }
      try {
        return await publish(cloneOffer(entry.offer));
      } catch (error) {
        if (created && this.entries.get(taskId) === entry) this.entries.delete(taskId);
        throw error;
      }
    });
  }

  async getOffer(taskId: string): Promise<MerchantOffer | undefined> {
    const entry = this.liveEntry(taskId);
    if (!entry) return undefined;
    this.entries.delete(taskId);
    this.entries.set(taskId, entry);
    return cloneOffer(entry.offer);
  }

  async claim(taskId: string): Promise<boolean> {
    const entry = this.liveEntry(taskId);
    if (!entry || entry.claimed) return false;
    entry.claimed = true;
    return true;
  }

  async getClaimStatus(
    taskId: string,
  ): Promise<MerchantOfferClaimStatus | undefined> {
    const entry = this.liveEntry(taskId);
    return entry ? (entry.claimed ? 'claimed' : 'available') : undefined;
  }

  async release(taskId: string): Promise<void> {
    const entry = this.liveEntry(taskId);
    if (entry) entry.claimed = false;
  }

  async delete(taskId: string): Promise<void> {
    this.entries.delete(taskId);
  }

  async deleteOffer(taskId: string): Promise<void> {
    await this.delete(taskId);
  }

  size(): number {
    this.purgeExpired();
    return this.entries.size;
  }

  private liveEntry(taskId: string): InMemoryEntry | undefined {
    const entry = this.entries.get(taskId);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && entry.expiresAt <= Date.now()) {
      this.entries.delete(taskId);
      return undefined;
    }
    return entry;
  }

  private purgeExpired(): void {
    const now = Date.now();
    for (const [taskId, entry] of this.entries) {
      if (entry.expiresAt !== undefined && entry.expiresAt <= now) {
        this.entries.delete(taskId);
      }
    }
  }

  private evictForInsert(taskId: string): void {
    if (this.entries.has(taskId)) return;
    while (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  private async withTaskLock<T>(taskId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(taskId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.queues.set(taskId, current);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.queues.get(taskId) === current) this.queues.delete(taskId);
    }
  }
}
