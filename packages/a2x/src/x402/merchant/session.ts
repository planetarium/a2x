import type { MerchantGate } from './gate.js';
import { meterMerchantUsage } from './pricing.js';
import type {
  MerchantDeferredObligation,
  MerchantGateSettleOutcome,
  MerchantMeterableUsage,
  MerchantUptoPricing,
} from './types.js';

export type UptoSessionEndReason =
  | 'budget-exhausted'
  | 'usage-unreported'
  | 'idle'
  | 'deadline'
  | 'manual'
  | 'shutdown';

export type UptoSessionState = 'active' | 'settling' | 'closed';

export type UptoSessionObligation = Extract<
  MerchantDeferredObligation,
  { scheme: 'upto' }
>;

type SettledOutcome = Extract<MerchantGateSettleOutcome, { kind: 'settled' }>;
type FailedOutcome = Extract<MerchantGateSettleOutcome, { kind: 'failed' }>;

export type UptoSessionSettlement =
  | { kind: 'settled'; outcome: SettledOutcome }
  | { kind: 'lapsed' }
  | { kind: 'failed'; outcome: FailedOutcome };

/** Durable state. Custom stores must preserve the held obligation verbatim. */
export interface UptoSessionRecord {
  contextId: string;
  taskId: string;
  revision: number;
  state: UptoSessionState;
  obligation: UptoSessionObligation;
  usage?: MerchantMeterableUsage;
  /** True after any turn could not be combined into the trusted usage total. */
  usageIncomplete?: boolean;
  turns: number;
  pendingTurnIds: string[];
  completedTurnIds: string[];
  authorizedMaxAtomic: string;
  openedAt: string;
  lastTurnAt: string;
  settleBy: string;
  authorizationDeadline?: string;
  closeRequestedReason?: UptoSessionEndReason;
  endReason?: UptoSessionEndReason;
  settlement?: UptoSessionSettlement;
  closedAt?: string;
}

/** Client-safe view; excludes the signed payment payload held for settlement. */
export interface UptoSessionSnapshot {
  contextId: string;
  taskId: string;
  revision: number;
  state: UptoSessionState;
  turns: number;
  pendingTurns: number;
  pendingTurnIds: string[];
  usage?: MerchantMeterableUsage;
  usageIncomplete: boolean;
  /** Null when the configured missing-usage policy refuses to select a charge. */
  chargeAtomic: string | null;
  authorizedMaxAtomic: string;
  openedAt: string;
  lastTurnAt: string;
  settleBy: string;
  authorizationDeadline?: string;
  closeRequestedReason?: UptoSessionEndReason;
  endReason?: UptoSessionEndReason;
  settlement?: UptoSessionSettlement;
  closedAt?: string;
}

export interface UptoSessionOutcome {
  session: UptoSessionSnapshot;
  /** Present when this operation won or observed the terminal transition. */
  settlement?: UptoSessionSettlement;
}

export interface UptoSessionRecovery {
  rearmed: number;
  closed: number;
  /** Never retried automatically because settlement may already have escaped. */
  unresolved: UptoSessionSnapshot[];
}

/**
 * Persistence boundary for held `upto` authorizations.
 *
 * `create` and `compareAndSet` MUST be atomic across replicas. `create` may
 * replace a successfully settled or lapsed closed record, but returns false
 * while the context is active or settling and while failed settlement evidence
 * is retained. `compareAndSet` rejects a record whose `contextId` differs from
 * its key and replaces the entire record only when `revision` still equals
 * `expectedRevision`. `listRecoverable` returns every active or settling record
 * needed to re-arm triggers after a restart.
 */
export interface UptoSessionStore {
  get(contextId: string): Promise<UptoSessionRecord | undefined>;
  create(record: UptoSessionRecord): Promise<boolean>;
  compareAndSet(
    contextId: string,
    expectedRevision: number,
    record: UptoSessionRecord,
  ): Promise<boolean>;
  /** Delete only when the caller still observes `expectedRevision`. */
  delete(contextId: string, expectedRevision: number): Promise<boolean>;
  listRecoverable(): Promise<UptoSessionRecord[]>;
}

export interface InMemoryUptoSessionStoreOptions {
  /** Maximum active, settling, and retained closed records. Defaults to 10,000. */
  maxEntries?: number;
  /** Retention for successful or lapsed records. Defaults to 3,600 seconds. */
  closedTtlSeconds?: number;
}

function cloneRecord(record: UptoSessionRecord): UptoSessionRecord {
  return structuredClone(record);
}

/** Single-process store. Durable multi-replica hosts must inject a shared CAS store. */
export class InMemoryUptoSessionStore implements UptoSessionStore {
  private readonly entries = new Map<string, UptoSessionRecord>();
  private readonly maxEntries: number;
  private readonly closedTtlMs: number;

  constructor(options: InMemoryUptoSessionStoreOptions = {}) {
    const maxEntries = options.maxEntries ?? 10_000;
    const closedTtlSeconds = options.closedTtlSeconds ?? 3_600;
    if (!Number.isInteger(maxEntries) || maxEntries <= 0) {
      throw new Error('InMemoryUptoSessionStore.maxEntries must be a positive integer.');
    }
    if (!Number.isFinite(closedTtlSeconds) || closedTtlSeconds <= 0) {
      throw new Error(
        'InMemoryUptoSessionStore.closedTtlSeconds must be greater than zero.',
      );
    }
    this.maxEntries = maxEntries;
    this.closedTtlMs = closedTtlSeconds * 1_000;
  }

  async get(contextId: string): Promise<UptoSessionRecord | undefined> {
    this.purgeClosed();
    const record = this.entries.get(contextId);
    return record ? cloneRecord(record) : undefined;
  }

  async create(record: UptoSessionRecord): Promise<boolean> {
    this.purgeClosed();
    const current = this.entries.get(record.contextId);
    if (
      current &&
      (current.state !== 'closed' || current.settlement?.kind === 'failed')
    ) {
      return false;
    }
    if (!current) this.evictClosedForInsert();
    this.entries.set(record.contextId, cloneRecord(record));
    return true;
  }

  async compareAndSet(
    contextId: string,
    expectedRevision: number,
    record: UptoSessionRecord,
  ): Promise<boolean> {
    if (record.contextId !== contextId) {
      throw new Error('Upto session record contextId must match its store key.');
    }
    const current = this.entries.get(contextId);
    if (!current || current.revision !== expectedRevision) return false;
    this.entries.set(contextId, cloneRecord(record));
    return true;
  }

  async listRecoverable(): Promise<UptoSessionRecord[]> {
    this.purgeClosed();
    return [...this.entries.values()]
      .filter((record) => record.state !== 'closed')
      .map(cloneRecord);
  }

  async delete(contextId: string, expectedRevision: number): Promise<boolean> {
    const current = this.entries.get(contextId);
    if (!current || current.revision !== expectedRevision) return false;
    this.entries.delete(contextId);
    return true;
  }

  size(): number {
    this.purgeClosed();
    return this.entries.size;
  }

  private purgeClosed(): void {
    const cutoff = Date.now() - this.closedTtlMs;
    for (const [contextId, record] of this.entries) {
      if (
        record.state === 'closed' &&
        record.settlement?.kind !== 'failed' &&
        record.closedAt !== undefined &&
        Date.parse(record.closedAt) <= cutoff
      ) {
        this.entries.delete(contextId);
      }
    }
  }

  private evictClosedForInsert(): void {
    if (this.entries.size < this.maxEntries) return;
    for (const [contextId, record] of this.entries) {
      if (record.state === 'closed' && record.settlement?.kind !== 'failed') {
        this.entries.delete(contextId);
        if (this.entries.size < this.maxEntries) return;
      }
    }
    throw new Error(
      'InMemoryUptoSessionStore has reached capacity with live or failed sessions.',
    );
  }
}

export interface UptoSessionManagerErrorContext {
  operation:
    | 'open'
    | 'reserve-open'
    | 'commit-open'
    | 'cancel-open'
    | 'record'
    | 'close'
    | 'recover'
    | 'timer';
  contextId?: string;
  taskId?: string;
}

export interface UptoSessionManagerOptions {
  gate: MerchantGate;
  store?: UptoSessionStore;
  /** Close after this many idle seconds. */
  idleSeconds: number;
  /** Absolute session-length ceiling even when the authorization lives longer. */
  maxDurationSeconds: number;
  /** Settle this many seconds before the signed Permit2 deadline. Defaults to 30. */
  deadlineGuardSeconds?: number;
  onError?: (
    error: unknown,
    context: UptoSessionManagerErrorContext,
  ) => void | Promise<void>;
}

export interface UptoSessionReserveOpenInput {
  contextId: string;
  taskId: string;
  obligation: UptoSessionObligation;
}

export interface UptoSessionOpenInput extends UptoSessionReserveOpenInput {
  usage: MerchantMeterableUsage;
}

export interface UptoSessionCommitOpenInput {
  contextId: string;
  taskId: string;
  usage: MerchantMeterableUsage;
}

export interface UptoSessionCancelOpenInput {
  contextId: string;
  taskId: string;
}

export interface UptoSessionRecordTurnInput {
  contextId: string;
  usage: MerchantMeterableUsage;
}

export interface UptoSessionTurnInput {
  contextId: string;
  /** Stable host turn identifier, such as the inbound A2A message id. */
  turnId: string;
}

export interface UptoSessionFinishTurnInput extends UptoSessionTurnInput {
  usage: MerchantMeterableUsage;
}

export type UptoSessionTurnStart =
  | { kind: 'started' }
  | { kind: 'inactive' }
  | { kind: 'duplicate'; status: 'pending' | 'completed' };

export type UptoSessionOpenReservation =
  | { kind: 'reserved'; session: UptoSessionSnapshot }
  | {
      kind: 'unavailable';
      reason: 'active' | 'settling' | 'closed-unreconciled' | 'deadline';
      session?: UptoSessionSnapshot;
    }
  | {
      kind: 'duplicate';
      status: 'pending' | 'completed';
      session: UptoSessionSnapshot;
    };

const MAX_CAS_ATTEMPTS = 100;

function validTokenCount(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validUsage(usage: MerchantMeterableUsage): boolean {
  if (usage.kind === 'unreported') return true;
  if (usage.kind === 'total') return validTokenCount(usage.totalTokens);
  const cached = usage.cachedInputTokens ?? 0;
  return (
    validTokenCount(usage.inputTokens) &&
    validTokenCount(usage.outputTokens) &&
    validTokenCount(cached) &&
    cached <= usage.inputTokens
  );
}

function detailedTotal(usage: Extract<MerchantMeterableUsage, { kind: 'detailed' }>): number {
  return usage.inputTokens + usage.outputTokens;
}

function mergeUsage(
  pricing: MerchantUptoPricing,
  current: MerchantMeterableUsage | undefined,
  currentIncomplete: boolean,
  next: MerchantMeterableUsage,
): { usage: MerchantMeterableUsage; incomplete: boolean } {
  if (!validUsage(next) || next.kind === 'unreported') {
    return {
      usage: current ? structuredClone(current) : { kind: 'unreported' },
      incomplete: true,
    };
  }
  if (current === undefined) {
    return { usage: structuredClone(next), incomplete: currentIncomplete };
  }
  if (current.kind === 'unreported') {
    return { usage: structuredClone(next), incomplete: true };
  }
  if (current.kind === 'detailed' && next.kind === 'detailed') {
    return {
      usage: {
        kind: 'detailed',
        inputTokens: current.inputTokens + next.inputTokens,
        outputTokens: current.outputTokens + next.outputTokens,
        cachedInputTokens:
          (current.cachedInputTokens ?? 0) + (next.cachedInputTokens ?? 0),
      },
      incomplete: currentIncomplete,
    };
  }
  if (current.kind === 'total' && next.kind === 'total') {
    return {
      usage: { kind: 'total', totalTokens: current.totalTokens + next.totalTokens },
      incomplete: currentIncomplete,
    };
  }
  if ('totalPerThousand' in pricing.rates) {
    const currentTotal =
      current.kind === 'total' ? current.totalTokens : detailedTotal(current);
    const nextTotal = next.kind === 'total' ? next.totalTokens : detailedTotal(next);
    return {
      usage: { kind: 'total', totalTokens: currentTotal + nextTotal },
      incomplete: currentIncomplete,
    };
  }
  const currentCharge = meterMerchantUsage(pricing, current);
  const nextCharge = meterMerchantUsage(pricing, next);
  return {
    usage:
      nextCharge.kind === 'charge' &&
      (currentCharge.kind !== 'charge' ||
        BigInt(nextCharge.amountAtomic) > BigInt(currentCharge.amountAtomic))
        ? structuredClone(next)
        : structuredClone(current),
    incomplete: true,
  };
}

function signedCap(obligation: UptoSessionObligation): bigint | undefined {
  const amount = obligation.classified.submission.permit2Authorization?.permitted.amount;
  return amount !== undefined && /^\d+$/.test(amount) ? BigInt(amount) : undefined;
}

function authorizedMax(obligation: UptoSessionObligation): bigint {
  const offered = BigInt(obligation.pricing.maxAmount);
  const signed = signedCap(obligation);
  return signed === undefined || offered < signed ? offered : signed;
}

function hasPendingOpen(record: UptoSessionRecord): boolean {
  return (
    record.state === 'active' &&
    record.turns === 0 &&
    record.pendingTurnIds.includes(record.taskId) &&
    !record.completedTurnIds.includes(record.taskId)
  );
}

function projectedCharge(record: UptoSessionRecord): bigint | undefined {
  if (record.turns === 0 && record.usage === undefined && !record.usageIncomplete) {
    return 0n;
  }
  const metered = meterMerchantUsage(record.obligation.pricing, record.usage);
  const cap = BigInt(record.authorizedMaxAtomic);
  if (record.usageIncomplete) {
    switch (record.obligation.pricing.unreportedUsage) {
      case 'ceiling':
        return cap;
      case 'floor': {
        const floor = BigInt(record.obligation.pricing.minAmount ?? '0');
        const known = metered.kind === 'charge' ? BigInt(metered.amountAtomic) : 0n;
        const charge = known > floor ? known : floor;
        return charge < cap ? charge : cap;
      }
      case 'refuse':
        return undefined;
    }
  }
  if (metered.kind === 'charge') {
    const charge = BigInt(metered.amountAtomic);
    return charge < cap ? charge : cap;
  }
  switch (record.obligation.pricing.unreportedUsage) {
    case 'ceiling':
      return cap;
    case 'floor': {
      const floor = BigInt(record.obligation.pricing.minAmount ?? '0');
      return floor < cap ? floor : cap;
    }
    case 'refuse':
      return undefined;
  }
}

function settlementUsage(record: UptoSessionRecord): MerchantMeterableUsage | undefined {
  if (!record.usageIncomplete) return record.usage;
  if (record.obligation.pricing.unreportedUsage !== 'floor') {
    return { kind: 'unreported' };
  }
  const metered = meterMerchantUsage(record.obligation.pricing, record.usage);
  const floor = BigInt(record.obligation.pricing.minAmount ?? '0');
  return metered.kind === 'charge' && BigInt(metered.amountAtomic) >= floor
    ? record.usage
    : { kind: 'unreported' };
}

function signedDeadlineMs(obligation: UptoSessionObligation): number | undefined {
  const value = obligation.classified.submission.permit2Authorization?.deadline;
  if (value === undefined || !/^\d+$/.test(value)) return undefined;
  const seconds = BigInt(value);
  const maxSeconds = BigInt(Math.floor(Number.MAX_SAFE_INTEGER / 1_000));
  return seconds > maxSeconds ? undefined : Number(seconds) * 1_000;
}

export class UptoSessionManager {
  readonly store: UptoSessionStore;
  private readonly timers = new Map<
    string,
    {
      idle?: ReturnType<typeof setTimeout>;
      deadline?: ReturnType<typeof setTimeout>;
    }
  >();
  private readonly idleMs: number;
  private readonly maxDurationMs: number;
  private readonly deadlineGuardMs: number;

  constructor(private readonly options: UptoSessionManagerOptions) {
    if (!Number.isFinite(options.idleSeconds) || options.idleSeconds <= 0) {
      throw new Error('UptoSessionManager.idleSeconds must be greater than zero.');
    }
    if (!Number.isFinite(options.maxDurationSeconds) || options.maxDurationSeconds <= 0) {
      throw new Error('UptoSessionManager.maxDurationSeconds must be greater than zero.');
    }
    const deadlineGuardSeconds = options.deadlineGuardSeconds ?? 30;
    if (!Number.isFinite(deadlineGuardSeconds) || deadlineGuardSeconds < 0) {
      throw new Error(
        'UptoSessionManager.deadlineGuardSeconds must be zero or greater.',
      );
    }
    this.store = options.store ?? new InMemoryUptoSessionStore();
    this.idleMs = options.idleSeconds * 1_000;
    this.maxDurationMs = options.maxDurationSeconds * 1_000;
    this.deadlineGuardMs = deadlineGuardSeconds * 1_000;
  }

  private draftOpenRecord(
    input: UptoSessionReserveOpenInput,
    now: number,
    pendingOpen: boolean,
  ): UptoSessionRecord {
    const signedDeadline = signedDeadlineMs(input.obligation);
    const settleBy = Math.min(
      now + this.maxDurationMs,
      signedDeadline === undefined
        ? Number.POSITIVE_INFINITY
        : signedDeadline - this.deadlineGuardMs,
    );
    return {
      contextId: input.contextId,
      taskId: input.taskId,
      revision: 0,
      state: 'active',
      obligation: input.obligation,
      turns: 0,
      pendingTurnIds: pendingOpen ? [input.taskId] : [],
      completedTurnIds: [],
      authorizedMaxAtomic: authorizedMax(input.obligation).toString(),
      openedAt: new Date(now).toISOString(),
      lastTurnAt: new Date(now).toISOString(),
      settleBy: new Date(settleBy).toISOString(),
      ...(signedDeadline === undefined
        ? {}
        : { authorizationDeadline: new Date(signedDeadline).toISOString() }),
    };
  }

  async lookup(contextId: string): Promise<UptoSessionSnapshot | undefined> {
    const record = await this.store.get(contextId);
    return record ? this.snapshot(record) : undefined;
  }

  async active(contextId: string): Promise<boolean> {
    const record = await this.store.get(contextId);
    return (
      record?.state === 'active' &&
      !hasPendingOpen(record) &&
      record.closeRequestedReason === undefined &&
      Date.now() < Date.parse(record.settleBy)
    );
  }

  /** Remove a reconciled closed record without racing a newer session. */
  async forgetClosed(contextId: string): Promise<boolean> {
    const record = await this.store.get(contextId);
    if (!record || record.state !== 'closed') return false;
    return await this.store.delete(contextId, record.revision);
  }

  /** Reserve a context before the opening turn performs resource work. */
  async reserveOpen(
    input: UptoSessionReserveOpenInput,
  ): Promise<UptoSessionOpenReservation> {
    try {
      const now = Date.now();
      const record = this.draftOpenRecord(input, now, true);

      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const current = await this.store.get(input.contextId);
        if (current) {
          if (current.taskId === input.taskId) {
            const status =
              current.turns > 0 ||
              current.completedTurnIds.includes(input.taskId) ||
              current.state === 'closed'
                ? 'completed'
                : 'pending';
            return { kind: 'duplicate', status, session: this.snapshot(current) };
          }
          const unavailableReason =
            current.state === 'active'
              ? 'active'
              : current.state === 'settling'
                ? 'settling'
                : current.settlement?.kind === 'failed'
                  ? 'closed-unreconciled'
                  : undefined;
          if (unavailableReason) {
            await this.options.gate.lapse(input.taskId);
            return {
              kind: 'unavailable',
              reason: unavailableReason,
              session: this.snapshot(current),
            };
          }
        }

        if (Date.now() >= Date.parse(record.settleBy)) {
          await this.options.gate.lapse(input.taskId);
          return { kind: 'unavailable', reason: 'deadline' };
        }
        if (await this.store.create(record)) {
          return { kind: 'reserved', session: this.snapshot(record) };
        }
      }
      throw new Error('Upto session opening reservation could not win its create race.');
    } catch (error) {
      await this.reportError(error, {
        operation: 'reserve-open',
        contextId: input.contextId,
        taskId: input.taskId,
      });
      throw error;
    }
  }

  /** Commit the opening turn's trusted usage exactly once. */
  async commitOpen(
    input: UptoSessionCommitOpenInput,
  ): Promise<UptoSessionOutcome | undefined> {
    return await this.applyUsage(
      input.contextId,
      input.usage,
      input.taskId,
      input.taskId,
      'commit-open',
    );
  }

  /** Cancel a reserved opening turn that produced no billable work. */
  async cancelOpen(
    input: UptoSessionCancelOpenInput,
  ): Promise<UptoSessionOutcome | undefined> {
    try {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const current = await this.store.get(input.contextId);
        if (!current || current.taskId !== input.taskId) return undefined;
        if (!hasPendingOpen(current)) return this.outcome(current);

        const settlement: UptoSessionSettlement = { kind: 'lapsed' };
        const closed: UptoSessionRecord = {
          ...current,
          revision: current.revision + 1,
          state: 'closed',
          pendingTurnIds: [],
          closeRequestedReason: undefined,
          endReason: 'manual',
          settlement,
          closedAt: new Date().toISOString(),
        };
        if (!(await this.store.compareAndSet(input.contextId, current.revision, closed))) {
          continue;
        }
        this.disarm(input.contextId);
        await this.options.gate.lapse(input.taskId);
        return { session: this.snapshot(closed), settlement };
      }
      throw new Error('Upto session opening cancellation lost its compare-and-set race.');
    } catch (error) {
      await this.reportError(error, {
        operation: 'cancel-open',
        contextId: input.contextId,
        taskId: input.taskId,
      });
      throw error;
    }
  }

  async open(input: UptoSessionOpenInput): Promise<UptoSessionOutcome> {
    const now = Date.now();
    const merged = mergeUsage(input.obligation.pricing, undefined, false, input.usage);
    const draft: UptoSessionRecord = {
      ...this.draftOpenRecord(input, now, false),
      usage: merged.usage,
      usageIncomplete: merged.incomplete,
      turns: 1,
    };
    const charge = projectedCharge(draft);
    const trigger =
      merged.incomplete
        ? 'usage-unreported'
        : charge !== undefined && charge >= BigInt(draft.authorizedMaxAtomic)
          ? 'budget-exhausted'
          : now >= Date.parse(draft.settleBy)
            ? 'deadline'
            : undefined;
    const record: UptoSessionRecord = trigger
      ? { ...draft, closeRequestedReason: trigger }
      : draft;
    try {
      if (!(await this.store.create(record))) {
        await this.options.gate.lapse(input.taskId);
        throw new Error(`An upto session is already live for context ${input.contextId}.`);
      }
      if (trigger) {
        const outcome = await this.close(input.contextId, trigger);
        if (!outcome) throw new Error('The newly opened upto session disappeared.');
        return outcome;
      }
      this.arm(record);
      return { session: this.snapshot(record) };
    } catch (error) {
      await this.reportError(error, {
        operation: 'open',
        contextId: input.contextId,
        taskId: input.taskId,
      });
      throw error;
    }
  }

  async recordTurn(input: UptoSessionRecordTurnInput): Promise<UptoSessionOutcome | undefined> {
    return await this.applyUsage(input.contextId, input.usage);
  }

  /** Reserve a live session before resource work starts. Idempotent per turn id. */
  async beginTurn(input: UptoSessionTurnInput): Promise<UptoSessionTurnStart> {
    try {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const current = await this.store.get(input.contextId);
        if (current?.state === 'active' && Date.now() >= Date.parse(current.settleBy)) {
          await this.close(input.contextId, 'deadline');
          return { kind: 'inactive' };
        }
        if (
          !current ||
          current.state !== 'active' ||
          hasPendingOpen(current) ||
          current.closeRequestedReason !== undefined ||
          Date.now() >= Date.parse(current.settleBy)
        ) {
          return { kind: 'inactive' };
        }
        if (current.completedTurnIds.includes(input.turnId)) {
          return { kind: 'duplicate', status: 'completed' };
        }
        if (current.pendingTurnIds.includes(input.turnId)) {
          return { kind: 'duplicate', status: 'pending' };
        }
        const now = Date.now();
        const next: UptoSessionRecord = {
          ...current,
          revision: current.revision + 1,
          pendingTurnIds: [...current.pendingTurnIds, input.turnId],
          lastTurnAt: new Date(now).toISOString(),
        };
        if (!(await this.store.compareAndSet(input.contextId, current.revision, next))) {
          continue;
        }
        this.arm(next);
        return { kind: 'started' };
      }
      throw new Error('Upto session turn could not win its compare-and-set race.');
    } catch (error) {
      await this.reportError(error, { operation: 'record', contextId: input.contextId });
      throw error;
    }
  }

  /** Complete a reserved turn and meter it exactly once. */
  async finishTurn(input: UptoSessionFinishTurnInput): Promise<UptoSessionOutcome | undefined> {
    return await this.applyUsage(input.contextId, input.usage, input.turnId);
  }

  /** Release a reserved turn that produced no billable work. */
  async cancelTurn(input: UptoSessionTurnInput): Promise<UptoSessionOutcome | undefined> {
    for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
      const current = await this.store.get(input.contextId);
      if (!current || current.state !== 'active') return undefined;
      if (!current.pendingTurnIds.includes(input.turnId)) {
        return { session: this.snapshot(current) };
      }
      const pendingTurnIds = current.pendingTurnIds.filter((id) => id !== input.turnId);
      const next: UptoSessionRecord = {
        ...current,
        revision: current.revision + 1,
        pendingTurnIds,
      };
      if (!(await this.store.compareAndSet(input.contextId, current.revision, next))) continue;
      if (pendingTurnIds.length === 0 && next.closeRequestedReason) {
        return await this.close(input.contextId, next.closeRequestedReason);
      }
      this.arm(next);
      return { session: this.snapshot(next) };
    }
    throw new Error('Upto session turn cancellation lost its compare-and-set race.');
  }

  async close(
    contextId: string,
    reason: UptoSessionEndReason = 'manual',
  ): Promise<UptoSessionOutcome | undefined> {
    try {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const current = await this.store.get(contextId);
        if (!current) return undefined;
        if (current.state !== 'active') {
          const session = this.snapshot(current);
          return {
            session,
            ...(current.settlement ? { settlement: current.settlement } : {}),
          };
        }
        const now = Date.now();
        if (
          reason === 'idle' &&
          current.closeRequestedReason === undefined &&
          now < Date.parse(current.lastTurnAt) + this.idleMs
        ) {
          this.arm(current);
          return { session: this.snapshot(current) };
        }
        if (
          reason === 'deadline' &&
          current.closeRequestedReason === undefined &&
          now < Date.parse(current.settleBy)
        ) {
          this.arm(current);
          return { session: this.snapshot(current) };
        }
        const closeReason = now >= Date.parse(current.settleBy) ? 'deadline' : reason;
        if (current.pendingTurnIds.length > 0) {
          if (closeReason !== 'deadline') {
            const waiting: UptoSessionRecord = {
              ...current,
              revision: current.revision + 1,
              closeRequestedReason: current.closeRequestedReason ?? closeReason,
            };
            if (!(await this.store.compareAndSet(contextId, current.revision, waiting))) {
              continue;
            }
            this.arm(waiting);
            return { session: this.snapshot(waiting) };
          }
        }
        const settling: UptoSessionRecord = {
          ...current,
          revision: current.revision + 1,
          state: 'settling',
          ...(current.pendingTurnIds.length > 0 ? { usageIncomplete: true } : {}),
          endReason: closeReason,
          closeRequestedReason: undefined,
        };
        if (!(await this.store.compareAndSet(contextId, current.revision, settling))) {
          continue;
        }
        this.disarm(contextId);

        const charge = projectedCharge(settling);
        let settlement: UptoSessionSettlement;
        if (
          charge === 0n &&
          settling.pendingTurnIds.length === 0 &&
          !settling.usageIncomplete
        ) {
          await this.options.gate.lapse(settling.taskId);
          settlement = { kind: 'lapsed' };
        } else {
          const usage = settlementUsage(settling);
          const outcome = await this.options.gate.settle({
            taskId: settling.taskId,
            obligation: settling.obligation,
            ...(usage === undefined ? {} : { usage }),
          });
          settlement =
            outcome.kind === 'settled'
              ? { kind: 'settled', outcome }
              : { kind: 'failed', outcome };
        }

        const closed: UptoSessionRecord = {
          ...settling,
          revision: settling.revision + 1,
          state: 'closed',
          settlement,
          closedAt: new Date().toISOString(),
        };
        if (!(await this.store.compareAndSet(contextId, settling.revision, closed))) {
          let observed = await this.store.get(contextId);
          if (
            observed?.state === 'settling' &&
            observed.taskId === settling.taskId &&
            observed.settlement === undefined
          ) {
            const evidenced: UptoSessionRecord = {
              ...observed,
              revision: observed.revision + 1,
              settlement,
            };
            observed = (await this.store.compareAndSet(
              contextId,
              observed.revision,
              evidenced,
            ))
              ? evidenced
              : await this.store.get(contextId);
          }
          const error = new Error(
            'Upto session settled but its terminal record could not be persisted.',
          );
          await this.reportError(error, {
            operation: 'close',
            contextId,
            taskId: settling.taskId,
          });
          return { session: this.snapshot(observed ?? settling), settlement };
        }
        return { session: this.snapshot(closed), settlement };
      }
      throw new Error('Upto session close could not win its compare-and-set race.');
    } catch (error) {
      await this.reportError(error, { operation: 'close', contextId });
      throw error;
    }
  }

  /** Re-arm active records and close overdue ones after a process restart. */
  async recover(): Promise<UptoSessionRecovery> {
    const recovery: UptoSessionRecovery = { rearmed: 0, closed: 0, unresolved: [] };
    try {
      for (const record of await this.store.listRecoverable()) {
        if (record.state === 'settling' || record.pendingTurnIds.length > 0) {
          recovery.unresolved.push(this.snapshot(record));
          continue;
        }
        const now = Date.now();
        const reason =
          now >= Date.parse(record.settleBy)
            ? 'deadline'
            : now >= Date.parse(record.lastTurnAt) + this.idleMs
              ? 'idle'
              : undefined;
        if (record.closeRequestedReason) {
          const outcome = await this.close(record.contextId, record.closeRequestedReason);
          if (outcome?.session.state === 'closed') recovery.closed += 1;
        } else if (reason) {
          const outcome = await this.close(record.contextId, reason);
          if (outcome?.session.state === 'closed') recovery.closed += 1;
        } else {
          this.arm(record);
          recovery.rearmed += 1;
        }
      }
      return recovery;
    } catch (error) {
      await this.reportError(error, { operation: 'recover' });
      throw error;
    }
  }

  async closeAll(reason: UptoSessionEndReason = 'shutdown'): Promise<void> {
    const records = await this.store.listRecoverable();
    await Promise.all(
      records
        .filter((record) => record.state === 'active')
        .map((record) => this.close(record.contextId, reason)),
    );
  }

  /** Stop local timers without changing durable state. */
  stop(): void {
    for (const contextId of this.timers.keys()) this.disarm(contextId);
  }

  private arm(record: UptoSessionRecord): void {
    this.disarm(record.contextId);
    if (hasPendingOpen(record)) return;
    const now = Date.now();
    if (record.closeRequestedReason) {
      const settleBy = Date.parse(record.settleBy);
      if (settleBy > now) {
        const deadline = setTimeout(() => {
          void this.close(record.contextId, 'deadline').catch((error) =>
            this.reportError(error, {
              operation: 'timer',
              contextId: record.contextId,
              taskId: record.taskId,
            }),
          );
        }, settleBy - now);
        deadline.unref?.();
        this.timers.set(record.contextId, { deadline });
      }
      return;
    }
    const idle = setTimeout(() => {
      void this.close(record.contextId, 'idle').catch((error) =>
        this.reportError(error, {
          operation: 'timer',
          contextId: record.contextId,
          taskId: record.taskId,
        }),
      );
    }, Math.max(0, Date.parse(record.lastTurnAt) + this.idleMs - now));
    const deadline = setTimeout(() => {
      void this.close(record.contextId, 'deadline').catch((error) =>
        this.reportError(error, {
          operation: 'timer',
          contextId: record.contextId,
          taskId: record.taskId,
        }),
      );
    }, Math.max(0, Date.parse(record.settleBy) - now));
    idle.unref?.();
    deadline.unref?.();
    this.timers.set(record.contextId, { idle, deadline });
  }

  private disarm(contextId: string): void {
    const timers = this.timers.get(contextId);
    if (timers?.idle) clearTimeout(timers.idle);
    if (timers?.deadline) clearTimeout(timers.deadline);
    this.timers.delete(contextId);
  }

  private snapshot(record: UptoSessionRecord): UptoSessionSnapshot {
    const charge = projectedCharge(record);
    return {
      contextId: record.contextId,
      taskId: record.taskId,
      revision: record.revision,
      state: record.state,
      turns: record.turns,
      pendingTurns: record.pendingTurnIds.length,
      pendingTurnIds: [...record.pendingTurnIds],
      ...(record.usage === undefined ? {} : { usage: structuredClone(record.usage) }),
      usageIncomplete: record.usageIncomplete ?? false,
      chargeAtomic: charge?.toString() ?? null,
      authorizedMaxAtomic: record.authorizedMaxAtomic,
      openedAt: record.openedAt,
      lastTurnAt: record.lastTurnAt,
      settleBy: record.settleBy,
      ...(record.authorizationDeadline
        ? { authorizationDeadline: record.authorizationDeadline }
        : {}),
      ...(record.closeRequestedReason
        ? { closeRequestedReason: record.closeRequestedReason }
        : {}),
      ...(record.endReason ? { endReason: record.endReason } : {}),
      ...(record.settlement ? { settlement: structuredClone(record.settlement) } : {}),
      ...(record.closedAt ? { closedAt: record.closedAt } : {}),
    };
  }

  private outcome(record: UptoSessionRecord): UptoSessionOutcome {
    return {
      session: this.snapshot(record),
      ...(record.settlement ? { settlement: record.settlement } : {}),
    };
  }

  private async reportError(
    error: unknown,
    context: UptoSessionManagerErrorContext,
  ): Promise<void> {
    try {
      await this.options.onError?.(error, context);
    } catch {
      // Observability hooks must not change payment state.
    }
  }

  private async applyUsage(
    contextId: string,
    usageInput: MerchantMeterableUsage,
    pendingTurnId?: string,
    expectedTaskId?: string,
    operation: 'record' | 'commit-open' = 'record',
  ): Promise<UptoSessionOutcome | undefined> {
    try {
      for (let attempt = 0; attempt < MAX_CAS_ATTEMPTS; attempt += 1) {
        const current = await this.store.get(contextId);
        if (!current) return undefined;
        if (expectedTaskId && current.taskId !== expectedTaskId) {
          throw new Error(
            `Upto session opening task ${expectedTaskId} does not match ${current.taskId}.`,
          );
        }
        if (pendingTurnId && current.completedTurnIds.includes(pendingTurnId)) {
          return this.outcome(current);
        }
        if (current.state !== 'active') return undefined;
        if (hasPendingOpen(current) && expectedTaskId !== current.taskId) {
          return undefined;
        }
        if (pendingTurnId && !current.pendingTurnIds.includes(pendingTurnId)) {
          return undefined;
        }
        const merged = mergeUsage(
          current.obligation.pricing,
          current.usage,
          current.usageIncomplete ?? false,
          usageInput,
        );
        const now = Date.now();
        const pendingTurnIds = pendingTurnId
          ? current.pendingTurnIds.filter((id) => id !== pendingTurnId)
          : current.pendingTurnIds;
        const completedTurnIds = pendingTurnId
          ? [...current.completedTurnIds, pendingTurnId]
          : current.completedTurnIds;
        const draft: UptoSessionRecord = {
          ...current,
          revision: current.revision + 1,
          usage: merged.usage,
          usageIncomplete: merged.incomplete,
          turns: current.turns + 1,
          pendingTurnIds,
          completedTurnIds,
          lastTurnAt: new Date(now).toISOString(),
        };
        const charge = projectedCharge(draft);
        const trigger =
          merged.incomplete
            ? 'usage-unreported'
            : charge !== undefined && charge >= BigInt(draft.authorizedMaxAtomic)
              ? 'budget-exhausted'
              : now >= Date.parse(draft.settleBy)
                ? 'deadline'
                : draft.closeRequestedReason;
        const next =
          trigger && pendingTurnIds.length > 0
            ? { ...draft, closeRequestedReason: draft.closeRequestedReason ?? trigger }
            : draft;
        if (!(await this.store.compareAndSet(contextId, current.revision, next))) continue;
        if (trigger && (pendingTurnIds.length === 0 || trigger === 'deadline')) {
          return await this.close(contextId, trigger);
        }
        this.arm(next);
        return { session: this.snapshot(next) };
      }
      throw new Error('Upto session update could not win its compare-and-set race.');
    } catch (error) {
      await this.reportError(error, { operation, contextId, taskId: expectedTaskId });
      throw error;
    }
  }
}
