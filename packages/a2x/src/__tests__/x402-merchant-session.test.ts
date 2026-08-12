import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  MerchantGate,
  MerchantGateSettleInput,
  MerchantGateSettleOutcome,
  MerchantUptoPricing,
  UptoSessionObligation,
  UptoSessionRecord,
} from '../x402/index.js';
import {
  InMemoryUptoSessionStore,
  UptoSessionManager,
} from '../x402/index.js';

const PRICING: MerchantUptoPricing = {
  scheme: 'upto',
  network: 'eip155:84532',
  maxAmount: '1000',
  minAmount: '10',
  rates: { totalPerThousand: '100' },
  unreportedUsage: 'ceiling',
  asset: '0xasset',
  payTo: '0xmerchant',
  resource: 'https://example.com/session',
  description: 'Conversation access',
  extra: { facilitatorAddress: '0xfacilitator' },
};

function obligation(
  options: {
    pricing?: MerchantUptoPricing;
    signedCap?: string;
    deadlineSeconds?: number;
  } = {},
): UptoSessionObligation {
  const pricing = options.pricing ?? PRICING;
  const deadline = options.deadlineSeconds ?? Math.floor(Date.now() / 1_000) + 600;
  return {
    kind: 'deferred',
    scheme: 'upto',
    pricing,
    classified: {
      kind: 'valid',
      submission: {
        permit2Authorization: {
          permitted: { amount: options.signedCap ?? pricing.maxAmount },
          deadline: String(deadline),
        },
      },
      requirement: {},
    } as UptoSessionObligation['classified'],
  };
}

function settled(amount = '0'): MerchantGateSettleOutcome {
  return {
    kind: 'settled',
    receipt: {
      success: true,
      transaction: '0xtx',
      network: 'eip155:84532',
      amount,
    },
    receiptMetadata: {},
    charge: { requestedAtomic: amount, amountAtomic: amount, basis: 'metered' },
  };
}

function fixture(options: {
  store?: InMemoryUptoSessionStore;
  settle?: (input: MerchantGateSettleInput) => Promise<MerchantGateSettleOutcome>;
  idleSeconds?: number;
  maxDurationSeconds?: number;
  deadlineGuardSeconds?: number;
} = {}) {
  const settle = vi.fn(
    options.settle ??
      (async (input: MerchantGateSettleInput) => {
        const usage = input.usage;
        const tokens =
          usage?.kind === 'total'
            ? usage.totalTokens
            : usage?.kind === 'detailed'
              ? usage.inputTokens + usage.outputTokens
              : 10_000;
        return settled(String(Math.ceil((tokens * 100) / 1_000)));
      }),
  );
  const lapse = vi.fn(async () => undefined);
  const gate = { settle, lapse } as unknown as MerchantGate;
  const manager = new UptoSessionManager({
    gate,
    store: options.store,
    idleSeconds: options.idleSeconds ?? 60,
    maxDurationSeconds: options.maxDurationSeconds ?? 600,
    deadlineGuardSeconds: options.deadlineGuardSeconds ?? 30,
  });
  return { gate, lapse, manager, settle };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('UptoSessionManager', () => {
  it('accumulates usage across turns and settles once on manual close', async () => {
    const { manager, settle } = fixture();
    const opened = await manager.open({
      contextId: 'c1',
      taskId: 't1',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
    });
    expect(opened.session).toMatchObject({ state: 'active', turns: 1, chargeAtomic: '10' });

    await manager.recordTurn({
      contextId: 'c1',
      usage: { kind: 'total', totalTokens: 250 },
    });
    const closed = await manager.close('c1');

    expect(closed?.session).toMatchObject({
      state: 'closed',
      turns: 2,
      chargeAtomic: '35',
      endReason: 'manual',
    });
    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith({
      taskId: 't1',
      obligation: expect.objectContaining({ scheme: 'upto' }),
      usage: { kind: 'total', totalTokens: 350 },
    });
    manager.stop();
  });

  it('persists the first turn usage atomically with session creation', async () => {
    class InspectCreateStore extends InMemoryUptoSessionStore {
      created?: UptoSessionRecord;

      override async create(record: UptoSessionRecord): Promise<boolean> {
        this.created = structuredClone(record);
        return await super.create(record);
      }
    }

    const store = new InspectCreateStore();
    const { manager } = fixture({ store });
    await manager.open({
      contextId: 'c-atomic-open',
      taskId: 't-atomic-open',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
    });

    expect(store.created).toMatchObject({
      state: 'active',
      turns: 1,
      usage: { kind: 'total', totalTokens: 100 },
    });
    manager.stop();
  });

  it('reserves the opening turn before usage is known', async () => {
    const { manager, settle } = fixture();

    const reserved = await manager.reserveOpen({
      contextId: 'c-reserve-open',
      taskId: 't-reserve-open',
      obligation: obligation(),
    });

    expect(reserved).toMatchObject({
      kind: 'reserved',
      session: {
        state: 'active',
        turns: 0,
        pendingTurns: 1,
        pendingTurnIds: ['t-reserve-open'],
        chargeAtomic: '0',
      },
    });
    await expect(manager.active('c-reserve-open')).resolves.toBe(false);
    await expect(
      manager.beginTurn({ contextId: 'c-reserve-open', turnId: 'm2' }),
    ).resolves.toEqual({ kind: 'inactive' });
    await expect(
      manager.recordTurn({
        contextId: 'c-reserve-open',
        usage: { kind: 'total', totalTokens: 100 },
      }),
    ).resolves.toBeUndefined();
    expect(settle).not.toHaveBeenCalled();
    manager.stop();
  });

  it('commits a reserved opening turn idempotently', async () => {
    const { manager } = fixture();
    await manager.reserveOpen({
      contextId: 'c-commit-open',
      taskId: 't-commit-open',
      obligation: obligation(),
    });

    const first = await manager.commitOpen({
      contextId: 'c-commit-open',
      taskId: 't-commit-open',
      usage: { kind: 'total', totalTokens: 100 },
    });
    const duplicate = await manager.commitOpen({
      contextId: 'c-commit-open',
      taskId: 't-commit-open',
      usage: { kind: 'total', totalTokens: 100 },
    });

    expect(first?.session).toMatchObject({
      state: 'active',
      turns: 1,
      pendingTurns: 0,
      usage: { kind: 'total', totalTokens: 100 },
    });
    expect(duplicate?.session).toMatchObject({
      turns: 1,
      usage: { kind: 'total', totalTokens: 100 },
    });
    await expect(manager.active('c-commit-open')).resolves.toBe(true);
    manager.stop();
  });

  it('does not commit an opening reservation from a different task', async () => {
    const { manager } = fixture();
    await manager.reserveOpen({
      contextId: 'c-wrong-open-task',
      taskId: 't-open-owner',
      obligation: obligation(),
    });

    await expect(
      manager.commitOpen({
        contextId: 'c-wrong-open-task',
        taskId: 't-open-other',
        usage: { kind: 'total', totalTokens: 100 },
      }),
    ).rejects.toThrow('does not match t-open-owner');
    await expect(manager.lookup('c-wrong-open-task')).resolves.toMatchObject({
      taskId: 't-open-owner',
      turns: 0,
      pendingTurnIds: ['t-open-owner'],
    });
    manager.stop();
  });

  it('recognizes retries of the same opening reservation without lapsing it', async () => {
    const { lapse, manager } = fixture();
    const input = {
      contextId: 'c-duplicate-open',
      taskId: 't-duplicate-open',
      obligation: obligation(),
    };
    await manager.reserveOpen(input);

    await expect(manager.reserveOpen(input)).resolves.toMatchObject({
      kind: 'duplicate',
      status: 'pending',
    });
    expect(lapse).not.toHaveBeenCalled();

    await manager.commitOpen({
      contextId: input.contextId,
      taskId: input.taskId,
      usage: { kind: 'total', totalTokens: 100 },
    });
    await expect(manager.reserveOpen(input)).resolves.toMatchObject({
      kind: 'duplicate',
      status: 'completed',
    });
    expect(lapse).not.toHaveBeenCalled();
    manager.stop();
  });

  it('lets only one opening reservation win before resource work', async () => {
    const { lapse, manager } = fixture();
    const [first, second] = await Promise.all([
      manager.reserveOpen({
        contextId: 'c-reserve-race',
        taskId: 't-reserve-a',
        obligation: obligation(),
      }),
      manager.reserveOpen({
        contextId: 'c-reserve-race',
        taskId: 't-reserve-b',
        obligation: obligation(),
      }),
    ]);

    const winner = first.kind === 'reserved' ? 't-reserve-a' : 't-reserve-b';
    const loser = winner === 't-reserve-a' ? 't-reserve-b' : 't-reserve-a';
    const unavailable = first.kind === 'unavailable' ? first : second;
    expect([first.kind, second.kind].sort()).toEqual(['reserved', 'unavailable']);
    expect(unavailable).toMatchObject({ kind: 'unavailable', reason: 'active' });
    expect(lapse).toHaveBeenCalledTimes(1);
    expect(lapse).toHaveBeenCalledWith(loser);
    await expect(manager.lookup('c-reserve-race')).resolves.toMatchObject({
      taskId: winner,
      turns: 0,
      pendingTurnIds: [winner],
    });
    manager.stop();
  });

  it('distinguishes settling and unreconciled contexts when reserving an opener', async () => {
    let releaseSettlement!: () => void;
    const settlementBlocked = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    const settling = fixture({
      settle: async () => {
        await settlementBlocked;
        return settled('10');
      },
    });
    await settling.manager.open({
      contextId: 'c-reserve-settling',
      taskId: 't-reserve-settling-owner',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
    });
    const closing = settling.manager.close('c-reserve-settling');
    await vi.waitFor(() => expect(settling.settle).toHaveBeenCalledTimes(1));

    await expect(
      settling.manager.reserveOpen({
        contextId: 'c-reserve-settling',
        taskId: 't-reserve-settling-new',
        obligation: obligation(),
      }),
    ).resolves.toMatchObject({ kind: 'unavailable', reason: 'settling' });
    expect(settling.lapse).toHaveBeenCalledWith('t-reserve-settling-new');
    releaseSettlement();
    await closing;
    settling.manager.stop();

    const failed: MerchantGateSettleOutcome = {
      kind: 'failed',
      code: 'settlement_failed',
      reason: 'facilitator unavailable',
    };
    const unreconciled = fixture({ settle: async () => failed });
    await unreconciled.manager.open({
      contextId: 'c-reserve-unreconciled',
      taskId: 't-reserve-unreconciled-owner',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
    });
    await unreconciled.manager.close('c-reserve-unreconciled');

    await expect(
      unreconciled.manager.reserveOpen({
        contextId: 'c-reserve-unreconciled',
        taskId: 't-reserve-unreconciled-new',
        obligation: obligation(),
      }),
    ).resolves.toMatchObject({
      kind: 'unavailable',
      reason: 'closed-unreconciled',
    });
    expect(unreconciled.lapse).toHaveBeenCalledWith('t-reserve-unreconciled-new');
    unreconciled.manager.stop();
  });

  it('cancels an unused opening reservation without charging it', async () => {
    const { lapse, manager, settle } = fixture();
    await manager.reserveOpen({
      contextId: 'c-cancel-open',
      taskId: 't-cancel-open',
      obligation: obligation(),
    });

    const canceled = await manager.cancelOpen({
      contextId: 'c-cancel-open',
      taskId: 't-cancel-open',
    });

    expect(canceled).toMatchObject({
      session: { state: 'closed', turns: 0, pendingTurns: 0, chargeAtomic: '0' },
      settlement: { kind: 'lapsed' },
    });
    expect(lapse).toHaveBeenCalledWith('t-cancel-open');
    expect(settle).not.toHaveBeenCalled();
    await expect(
      manager.reserveOpen({
        contextId: 'c-cancel-open',
        taskId: 't-cancel-open',
        obligation: obligation(),
      }),
    ).resolves.toMatchObject({ kind: 'duplicate', status: 'completed' });
    expect(lapse).toHaveBeenCalledTimes(1);
    await expect(
      manager.commitOpen({
        contextId: 'c-cancel-open',
        taskId: 't-cancel-open',
        usage: { kind: 'total', totalTokens: 100 },
      }),
    ).resolves.toBeUndefined();
  });

  it('lets only one of opening commit and cancellation win its CAS race', async () => {
    const committed = fixture();
    await committed.manager.reserveOpen({
      contextId: 'c-open-commit-wins',
      taskId: 't-open-commit-wins',
      obligation: obligation(),
    });
    await Promise.all([
      committed.manager.commitOpen({
        contextId: 'c-open-commit-wins',
        taskId: 't-open-commit-wins',
        usage: { kind: 'total', totalTokens: 100 },
      }),
      committed.manager.cancelOpen({
        contextId: 'c-open-commit-wins',
        taskId: 't-open-commit-wins',
      }),
    ]);
    await expect(committed.manager.lookup('c-open-commit-wins')).resolves.toMatchObject({
      state: 'active',
      turns: 1,
      usage: { kind: 'total', totalTokens: 100 },
    });
    expect(committed.lapse).not.toHaveBeenCalled();
    committed.manager.stop();

    const canceled = fixture();
    await canceled.manager.reserveOpen({
      contextId: 'c-open-cancel-wins',
      taskId: 't-open-cancel-wins',
      obligation: obligation(),
    });
    await Promise.all([
      canceled.manager.cancelOpen({
        contextId: 'c-open-cancel-wins',
        taskId: 't-open-cancel-wins',
      }),
      canceled.manager.commitOpen({
        contextId: 'c-open-cancel-wins',
        taskId: 't-open-cancel-wins',
        usage: { kind: 'total', totalTokens: 100 },
      }),
    ]);
    await expect(canceled.manager.lookup('c-open-cancel-wins')).resolves.toMatchObject({
      state: 'closed',
      turns: 0,
      settlement: { kind: 'lapsed' },
    });
    expect(canceled.lapse).toHaveBeenCalledTimes(1);
  });

  it('refuses an opening reservation after the guarded deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
    const deadlineSeconds = Math.floor(Date.now() / 1_000) + 20;
    const { lapse, manager } = fixture({ deadlineGuardSeconds: 30 });

    await expect(
      manager.reserveOpen({
        contextId: 'c-reserve-expired',
        taskId: 't-reserve-expired',
        obligation: obligation({ deadlineSeconds }),
      }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'deadline' });
    expect(lapse).toHaveBeenCalledWith('t-reserve-expired');
    await expect(manager.lookup('c-reserve-expired')).resolves.toBeUndefined();
  });

  it('rechecks the guarded deadline after losing the opening create race', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));

    class DeadlineRaceStore extends InMemoryUptoSessionStore {
      createCalls = 0;

      override async create(record: UptoSessionRecord): Promise<boolean> {
        this.createCalls += 1;
        if (this.createCalls === 1) {
          vi.setSystemTime(new Date(record.settleBy));
          return false;
        }
        return await super.create(record);
      }
    }

    const store = new DeadlineRaceStore();
    const deadlineSeconds = Math.floor(Date.now() / 1_000) + 31;
    const { lapse, manager } = fixture({ store, deadlineGuardSeconds: 30 });

    await expect(
      manager.reserveOpen({
        contextId: 'c-reserve-deadline-race',
        taskId: 't-reserve-deadline-race',
        obligation: obligation({ deadlineSeconds }),
      }),
    ).resolves.toEqual({ kind: 'unavailable', reason: 'deadline' });
    expect(store.createCalls).toBe(1);
    expect(lapse).toHaveBeenCalledWith('t-reserve-deadline-race');
    await expect(manager.lookup('c-reserve-deadline-race')).resolves.toBeUndefined();
  });

  it('arms no automatic trigger until the reserved opening usage is committed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
    const deadlineSeconds = Math.floor(Date.now() / 1_000) + 60;
    const { manager, settle } = fixture({
      idleSeconds: 300,
      maxDurationSeconds: 600,
      deadlineGuardSeconds: 30,
    });
    await manager.reserveOpen({
      contextId: 'c-reserve-deadline',
      taskId: 't-reserve-deadline',
      obligation: obligation({ deadlineSeconds }),
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(settle).not.toHaveBeenCalled();
    await expect(manager.lookup('c-reserve-deadline')).resolves.toMatchObject({
      state: 'active',
      turns: 0,
      pendingTurnIds: ['t-reserve-deadline'],
      usageIncomplete: false,
    });

    const committed = await manager.commitOpen({
      contextId: 'c-reserve-deadline',
      taskId: 't-reserve-deadline',
      usage: { kind: 'total', totalTokens: 100 },
    });

    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ usage: { kind: 'total', totalTokens: 100 } }),
    );
    expect(committed?.session).toMatchObject({
      state: 'closed',
      turns: 1,
      pendingTurnIds: [],
      usageIncomplete: false,
      endReason: 'deadline',
    });
  });

  it('clamps the session budget to the payer signed cap and settles inline', async () => {
    const { manager, settle } = fixture();
    const outcome = await manager.open({
      contextId: 'c-budget',
      taskId: 't-budget',
      obligation: obligation({ signedCap: '25' }),
      usage: { kind: 'total', totalTokens: 1_000 },
    });

    expect(outcome.session).toMatchObject({
      state: 'closed',
      endReason: 'budget-exhausted',
      authorizedMaxAtomic: '25',
      chargeAtomic: '25',
    });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('ends immediately when usage becomes unreported and delegates policy to the gate', async () => {
    const failed: MerchantGateSettleOutcome = {
      kind: 'failed',
      code: 'settlement_failed',
      reason: 'Usage was not reported in a shape that can be priced safely.',
    };
    const { manager, settle } = fixture({ settle: async () => failed });
    const pricing: MerchantUptoPricing = { ...PRICING, unreportedUsage: 'refuse' };

    const outcome = await manager.open({
      contextId: 'c-unreported',
      taskId: 't-unreported',
      obligation: obligation({ pricing }),
      usage: { kind: 'unreported' },
    });

    expect(outcome.session).toMatchObject({
      state: 'closed',
      endReason: 'usage-unreported',
      chargeAtomic: null,
      settlement: { kind: 'failed' },
    });
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ usage: { kind: 'unreported' } }),
    );
  });

  it('lapses trusted zero usage without consuming the authorization', async () => {
    const { lapse, manager, settle } = fixture();
    await manager.open({
      contextId: 'c-zero',
      taskId: 't-zero',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 0 },
    });

    const outcome = await manager.close('c-zero', 'manual');

    expect(outcome?.settlement).toEqual({ kind: 'lapsed' });
    expect(lapse).toHaveBeenCalledWith('t-zero');
    expect(settle).not.toHaveBeenCalled();
  });

  it('resets the idle trigger after each turn', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
    const { manager, settle } = fixture({ idleSeconds: 10 });
    await manager.open({
      contextId: 'c-idle',
      taskId: 't-idle',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
    });
    await vi.advanceTimersByTimeAsync(9_000);
    await manager.recordTurn({
      contextId: 'c-idle',
      usage: { kind: 'total', totalTokens: 100 },
    });
    await vi.advanceTimersByTimeAsync(9_000);
    expect(settle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1_000);
    expect(settle).toHaveBeenCalledTimes(1);
    await expect(manager.lookup('c-idle')).resolves.toMatchObject({
      state: 'closed',
      endReason: 'idle',
    });
  });

  it('holds an idle close until an in-flight turn records its usage', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
    const { manager, settle } = fixture({ idleSeconds: 10 });
    await manager.open({
      contextId: 'c-in-flight',
      taskId: 't-in-flight',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
    });
    await vi.advanceTimersByTimeAsync(9_000);
    await expect(
      manager.beginTurn({ contextId: 'c-in-flight', turnId: 'm2' }),
    ).resolves.toEqual({ kind: 'started' });
    await vi.advanceTimersByTimeAsync(10_000);

    expect(settle).not.toHaveBeenCalled();
    await expect(manager.lookup('c-in-flight')).resolves.toMatchObject({
      state: 'active',
      pendingTurns: 1,
      closeRequestedReason: 'idle',
    });
    await expect(manager.active('c-in-flight')).resolves.toBe(false);

    const finished = await manager.finishTurn({
      contextId: 'c-in-flight',
      turnId: 'm2',
      usage: { kind: 'total', totalTokens: 50 },
    });
    expect(finished?.session).toMatchObject({ state: 'closed', turns: 2 });
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ usage: { kind: 'total', totalTokens: 150 } }),
    );
  });

  it('meters a leased turn idempotently', async () => {
    const { manager } = fixture();
    await manager.open({
      contextId: 'c-idempotent-turn',
      taskId: 't-idempotent-turn',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
    });
    await expect(
      manager.beginTurn({ contextId: 'c-idempotent-turn', turnId: 'm2' }),
    ).resolves.toEqual({ kind: 'started' });
    await expect(
      manager.beginTurn({ contextId: 'c-idempotent-turn', turnId: 'm2' }),
    ).resolves.toEqual({ kind: 'duplicate', status: 'pending' });

    await Promise.all([
      manager.finishTurn({
        contextId: 'c-idempotent-turn',
        turnId: 'm2',
        usage: { kind: 'total', totalTokens: 50 },
      }),
      manager.finishTurn({
        contextId: 'c-idempotent-turn',
        turnId: 'm2',
        usage: { kind: 'total', totalTokens: 50 },
      }),
    ]);

    await expect(manager.lookup('c-idempotent-turn')).resolves.toMatchObject({
      turns: 2,
      pendingTurns: 0,
      usage: { kind: 'total', totalTokens: 150 },
    });
    await expect(
      manager.beginTurn({ contextId: 'c-idempotent-turn', turnId: 'm2' }),
    ).resolves.toEqual({ kind: 'duplicate', status: 'completed' });
    manager.stop();
  });

  it('lets a canceled in-flight turn release a requested close', async () => {
    const { manager, settle } = fixture();
    await manager.open({
      contextId: 'c-cancel-turn',
      taskId: 't-cancel-turn',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
    });
    await manager.beginTurn({ contextId: 'c-cancel-turn', turnId: 'm2' });
    await manager.close('c-cancel-turn', 'manual');

    const canceled = await manager.cancelTurn({ contextId: 'c-cancel-turn', turnId: 'm2' });

    expect(canceled?.session).toMatchObject({ state: 'closed', turns: 1 });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('uses the guarded signed deadline when it is earlier than the configured maximum', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
    const deadlineSeconds = Math.floor(Date.now() / 1_000) + 60;
    const { manager, settle } = fixture({
      idleSeconds: 300,
      maxDurationSeconds: 600,
      deadlineGuardSeconds: 30,
    });
    await manager.open({
      contextId: 'c-deadline',
      taskId: 't-deadline',
      obligation: obligation({ deadlineSeconds }),
      usage: { kind: 'total', totalTokens: 100 },
    });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(settle).toHaveBeenCalledTimes(1);
    await expect(manager.lookup('c-deadline')).resolves.toMatchObject({
      state: 'closed',
      endReason: 'deadline',
    });
  });

  it('settles inline when the authorization guard has already passed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
    const deadlineSeconds = Math.floor(Date.now() / 1_000) + 20;
    const { manager, settle } = fixture({ deadlineGuardSeconds: 30 });

    const outcome = await manager.open({
      contextId: 'c-expired-guard',
      taskId: 't-expired-guard',
      obligation: obligation({ deadlineSeconds }),
      usage: { kind: 'total', totalTokens: 100 },
    });

    expect(settle).toHaveBeenCalledTimes(1);
    expect(outcome.session).toMatchObject({ state: 'closed', endReason: 'deadline' });
  });

  it('settles at the guard when a turn is still in flight', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
    const deadlineSeconds = Math.floor(Date.now() / 1_000) + 60;
    const { manager, settle } = fixture({
      idleSeconds: 300,
      maxDurationSeconds: 600,
      deadlineGuardSeconds: 30,
    });
    await manager.open({
      contextId: 'c-hard-deadline',
      taskId: 't-hard-deadline',
      obligation: obligation({ deadlineSeconds }),
      usage: { kind: 'total', totalTokens: 100 },
    });
    await vi.advanceTimersByTimeAsync(29_000);
    await manager.beginTurn({ contextId: 'c-hard-deadline', turnId: 'm2' });
    await vi.advanceTimersByTimeAsync(1_000);

    expect(settle).toHaveBeenCalledTimes(1);
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ usage: { kind: 'unreported' } }),
    );
    await expect(manager.lookup('c-hard-deadline')).resolves.toMatchObject({
      state: 'closed',
      endReason: 'deadline',
      pendingTurns: 1,
      pendingTurnIds: ['m2'],
      usageIncomplete: true,
    });
  });

  it('applies unreported usage policy instead of lapsing an unresolved turn', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
    const deadlineSeconds = Math.floor(Date.now() / 1_000) + 60;
    const { lapse, manager, settle } = fixture({
      idleSeconds: 300,
      maxDurationSeconds: 600,
      deadlineGuardSeconds: 30,
    });
    await manager.open({
      contextId: 'c-unresolved-zero',
      taskId: 't-unresolved-zero',
      obligation: obligation({ deadlineSeconds }),
      usage: { kind: 'total', totalTokens: 0 },
    });
    await manager.beginTurn({ contextId: 'c-unresolved-zero', turnId: 'm2' });

    await vi.advanceTimersByTimeAsync(30_000);

    expect(lapse).not.toHaveBeenCalled();
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ usage: { kind: 'unreported' } }),
    );
    await expect(manager.lookup('c-unresolved-zero')).resolves.toMatchObject({
      state: 'closed',
      usage: { kind: 'total', totalTokens: 0 },
      usageIncomplete: true,
      pendingTurns: 1,
    });
  });

  it('preserves already-metered value when floor policy sees unreported usage', async () => {
    const pricing: MerchantUptoPricing = { ...PRICING, unreportedUsage: 'floor' };
    const { manager, settle } = fixture();
    await manager.open({
      contextId: 'c-floor-history',
      taskId: 't-floor-history',
      obligation: obligation({ pricing }),
      usage: { kind: 'total', totalTokens: 5_000 },
    });

    const outcome = await manager.recordTurn({
      contextId: 'c-floor-history',
      usage: { kind: 'unreported' },
    });

    expect(outcome?.session).toMatchObject({
      state: 'closed',
      chargeAtomic: '500',
      usage: { kind: 'total', totalTokens: 5_000 },
      usageIncomplete: true,
    });
    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ usage: { kind: 'total', totalTokens: 5_000 } }),
    );
  });

  it('enforces max duration when a requested close is waiting on an in-flight turn', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
    const { manager, settle } = fixture({
      idleSeconds: 300,
      maxDurationSeconds: 20,
    });
    await manager.open({
      contextId: 'c-max-duration-pending',
      taskId: 't-max-duration-pending',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
    });
    await manager.beginTurn({ contextId: 'c-max-duration-pending', turnId: 'm2' });
    await manager.close('c-max-duration-pending', 'manual');

    await vi.advanceTimersByTimeAsync(19_999);
    expect(settle).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(settle).toHaveBeenCalledTimes(1);
    await expect(manager.lookup('c-max-duration-pending')).resolves.toMatchObject({
      state: 'closed',
      endReason: 'deadline',
      pendingTurns: 1,
    });
  });

  it('does not lose concurrent turn usage under compare-and-set contention', async () => {
    const { manager } = fixture();
    await manager.open({
      contextId: 'c-concurrent',
      taskId: 't-concurrent',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 1 },
    });

    await Promise.all(
      Array.from({ length: 20 }, () =>
        manager.recordTurn({
          contextId: 'c-concurrent',
          usage: { kind: 'total', totalTokens: 1 },
        }),
      ),
    );

    await expect(manager.lookup('c-concurrent')).resolves.toMatchObject({
      turns: 21,
      usage: { kind: 'total', totalTokens: 21 },
    });
    manager.stop();
  });

  it('allows only one concurrent closer to call settlement', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { manager, settle } = fixture({
      settle: async () => {
        await blocked;
        return settled('10');
      },
    });
    await manager.open({
      contextId: 'c-close-race',
      taskId: 't-close-race',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
    });

    const first = manager.close('c-close-race', 'manual');
    await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(1));
    const second = await manager.close('c-close-race', 'idle');
    release();
    await first;

    expect(second?.session.state).toBe('settling');
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('keeps a failed terminal write unresolved and preserves settlement evidence', async () => {
    class TerminalWriteFailsOnceStore extends InMemoryUptoSessionStore {
      private failed = false;

      override async compareAndSet(
        contextId: string,
        expectedRevision: number,
        record: UptoSessionRecord,
      ): Promise<boolean> {
        if (record.state === 'closed' && !this.failed) {
          this.failed = true;
          return false;
        }
        return await super.compareAndSet(contextId, expectedRevision, record);
      }
    }

    const store = new TerminalWriteFailsOnceStore();
    const { manager, settle } = fixture({ store });
    await manager.open({
      contextId: 'c-terminal-write',
      taskId: 't-terminal-write',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
    });

    const outcome = await manager.close('c-terminal-write');

    expect(settle).toHaveBeenCalledTimes(1);
    expect(outcome).toMatchObject({
      session: { state: 'settling', settlement: { kind: 'settled' } },
      settlement: { kind: 'settled' },
    });
    await expect(manager.recover()).resolves.toMatchObject({
      closed: 0,
      unresolved: [{ state: 'settling', settlement: { kind: 'settled' } }],
    });
    expect(settle).toHaveBeenCalledTimes(1);
  });

  it('recovers overdue active sessions and re-arms future sessions', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
    const store = new InMemoryUptoSessionStore();
    const first = fixture({ store, idleSeconds: 10 });
    await first.manager.open({
      contextId: 'c-overdue',
      taskId: 't-overdue',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
    });
    first.manager.stop();
    vi.setSystemTime(new Date('2026-08-11T00:00:11Z'));
    const recovered = fixture({ store, idleSeconds: 10 });

    await expect(recovered.manager.recover()).resolves.toMatchObject({
      closed: 1,
      rearmed: 0,
      unresolved: [],
    });
    expect(recovered.settle).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date('2026-08-11T00:01:00Z'));
    await recovered.manager.open({
      contextId: 'c-future',
      taskId: 't-future',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
    });
    recovered.manager.stop();
    const resumed = fixture({ store, idleSeconds: 10 });
    await expect(resumed.manager.recover()).resolves.toMatchObject({ rearmed: 1 });
    resumed.manager.stop();
  });

  it('reports interrupted settling records without retrying a possibly escaped payment', async () => {
    const store = new InMemoryUptoSessionStore();
    const now = new Date().toISOString();
    const record: UptoSessionRecord = {
      contextId: 'c-unresolved',
      taskId: 't-unresolved',
      revision: 2,
      state: 'settling',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
      turns: 1,
      pendingTurnIds: [],
      completedTurnIds: [],
      authorizedMaxAtomic: '1000',
      openedAt: now,
      lastTurnAt: now,
      settleBy: now,
      endReason: 'deadline',
    };
    await store.create(record);
    const { manager, settle } = fixture({ store });

    const recovery = await manager.recover();

    expect(recovery.unresolved).toHaveLength(1);
    expect(recovery.unresolved[0]).toMatchObject({
      contextId: 'c-unresolved',
      state: 'settling',
    });
    expect(settle).not.toHaveBeenCalled();
  });

  it('reports recovered in-flight turns for host reconciliation', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
    const store = new InMemoryUptoSessionStore();
    const first = fixture({ store });
    await first.manager.open({
      contextId: 'c-pending-recovery',
      taskId: 't-pending-recovery',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
    });
    await first.manager.beginTurn({ contextId: 'c-pending-recovery', turnId: 'm2' });
    first.manager.stop();
    const recovered = fixture({ store });

    const recovery = await recovered.manager.recover();

    expect(recovery.unresolved).toHaveLength(1);
    expect(recovery.unresolved[0]).toMatchObject({
      contextId: 'c-pending-recovery',
      state: 'active',
      pendingTurns: 1,
      pendingTurnIds: ['m2'],
    });
    await vi.advanceTimersByTimeAsync(600_000);
    expect(recovered.settle).not.toHaveBeenCalled();
  });

  it('reports an uncommitted opening reservation for host reconciliation', async () => {
    const store = new InMemoryUptoSessionStore();
    const first = fixture({ store });
    await first.manager.reserveOpen({
      contextId: 'c-open-recovery',
      taskId: 't-open-recovery',
      obligation: obligation(),
    });
    first.manager.stop();
    const recovered = fixture({ store });

    await expect(recovered.manager.recover()).resolves.toMatchObject({
      rearmed: 0,
      closed: 0,
      unresolved: [
        {
          contextId: 'c-open-recovery',
          taskId: 't-open-recovery',
          turns: 0,
          pendingTurnIds: ['t-open-recovery'],
        },
      ],
    });
    expect(recovered.settle).not.toHaveBeenCalled();
  });

  it('merges detailed and total readings only for total-rate pricing', async () => {
    const { manager, settle } = fixture();
    await manager.open({
      contextId: 'c-mixed',
      taskId: 't-mixed',
      obligation: obligation(),
      usage: { kind: 'detailed', inputTokens: 100, outputTokens: 50 },
    });
    await manager.recordTurn({
      contextId: 'c-mixed',
      usage: { kind: 'total', totalTokens: 25 },
    });
    await manager.close('c-mixed');

    expect(settle).toHaveBeenCalledWith(
      expect.objectContaining({ usage: { kind: 'total', totalTokens: 175 } }),
    );
  });

  it('can replace a retained closed record with a new authorization', async () => {
    const { manager } = fixture();
    await manager.open({
      contextId: 'c-reopen',
      taskId: 't-old',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
    });
    await manager.close('c-reopen');

    const reopened = await manager.open({
      contextId: 'c-reopen',
      taskId: 't-new',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
    });

    expect(reopened.session).toMatchObject({ state: 'active', taskId: 't-new', turns: 1 });
    manager.stop();
  });

  it('lapses a verified authorization that loses a concurrent context open', async () => {
    const { lapse, manager } = fixture();
    await manager.open({
      contextId: 'c-open-race',
      taskId: 't-open-winner',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
    });

    await expect(
      manager.open({
        contextId: 'c-open-race',
        taskId: 't-open-loser',
        obligation: obligation(),
        usage: { kind: 'total', totalTokens: 100 },
      }),
    ).rejects.toThrow('already live');
    expect(lapse).toHaveBeenCalledWith('t-open-loser');
    await expect(manager.lookup('c-open-race')).resolves.toMatchObject({
      taskId: 't-open-winner',
      state: 'active',
    });
    manager.stop();
  });

  it('keeps failed settlement evidence until an operator explicitly forgets it', async () => {
    const failed: MerchantGateSettleOutcome = {
      kind: 'failed',
      code: 'settlement_failed',
      reason: 'facilitator unavailable',
    };
    const { manager } = fixture({ settle: async () => failed });
    await manager.open({
      contextId: 'c-reconcile',
      taskId: 't-failed',
      obligation: obligation(),
      usage: { kind: 'total', totalTokens: 100 },
    });
    await manager.close('c-reconcile');

    await expect(
      manager.open({
        contextId: 'c-reconcile',
        taskId: 't-blocked',
        obligation: obligation(),
        usage: { kind: 'total', totalTokens: 100 },
      }),
    ).rejects.toThrow('already live');
    await expect(manager.forgetClosed('c-reconcile')).resolves.toBe(true);
    await expect(
      manager.open({
        contextId: 'c-reconcile',
        taskId: 't-retried',
        obligation: obligation(),
        usage: { kind: 'total', totalTokens: 100 },
      }),
    ).resolves.toMatchObject({ session: { taskId: 't-retried', state: 'active' } });
    manager.stop();
  });
});

describe('InMemoryUptoSessionStore', () => {
  it('enforces revision compare-and-set', async () => {
    const store = new InMemoryUptoSessionStore();
    const now = new Date().toISOString();
    const record: UptoSessionRecord = {
      contextId: 'c-cas',
      taskId: 't-cas',
      revision: 0,
      state: 'active',
      obligation: obligation(),
      turns: 0,
      pendingTurnIds: [],
      completedTurnIds: [],
      authorizedMaxAtomic: '1000',
      openedAt: now,
      lastTurnAt: now,
      settleBy: now,
    };
    await expect(store.create(record)).resolves.toBe(true);

    await expect(
      store.compareAndSet('c-cas', 1, { ...record, revision: 2 }),
    ).resolves.toBe(false);
    await expect(
      store.compareAndSet('c-cas', 0, { ...record, revision: 1, turns: 1 }),
    ).resolves.toBe(true);
    await expect(
      store.compareAndSet('c-cas', 1, {
        ...record,
        contextId: 'c-other',
        revision: 2,
      }),
    ).rejects.toThrow('contextId must match');
    await expect(store.get('c-cas')).resolves.toMatchObject({ revision: 1, turns: 1 });
  });

  it('never evicts an active authorization to make room', async () => {
    const store = new InMemoryUptoSessionStore({ maxEntries: 1 });
    const now = new Date().toISOString();
    const record: UptoSessionRecord = {
      contextId: 'c-cap-1',
      taskId: 't-cap-1',
      revision: 0,
      state: 'active',
      obligation: obligation(),
      turns: 0,
      pendingTurnIds: [],
      completedTurnIds: [],
      authorizedMaxAtomic: '1000',
      openedAt: now,
      lastTurnAt: now,
      settleBy: now,
    };
    await store.create(record);

    await expect(
      store.create({ ...record, contextId: 'c-cap-2', taskId: 't-cap-2' }),
    ).rejects.toThrow('capacity with live or failed sessions');
    await expect(store.get('c-cap-1')).resolves.toBeDefined();
  });
});
