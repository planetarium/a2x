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

  it('waits for an in-flight turn after the guard but never past the signed deadline', async () => {
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

    expect(settle).not.toHaveBeenCalled();
    await expect(manager.lookup('c-hard-deadline')).resolves.toMatchObject({
      closeRequestedReason: 'deadline',
      pendingTurns: 1,
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(settle).toHaveBeenCalledTimes(1);
    await expect(manager.lookup('c-hard-deadline')).resolves.toMatchObject({
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
