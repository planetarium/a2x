import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../types/common.js';
import {
  MerchantGate,
  merchantPricingToAccept,
  type MerchantBatchSettlementPricing,
  type MerchantExactPricing,
  type MerchantGateErrorContext,
  type MerchantOffer,
  type MerchantUptoPricing,
} from '../x402/index.js';
import {
  X402_ERROR_CODES,
  X402_EXTENSION_URI,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
} from '../x402/constants.js';
import { X402Context } from '../x402/context.js';
import type {
  X402Facilitator,
  X402PaymentPayload,
  X402PaymentRequirements,
  X402ResourceServer,
} from '../x402/types.js';
import { encodeRequirementV2 } from '../x402/wire-v2.js';

const PAY_TO = '0x2222222222222222222222222222222222222222';
const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAYER = '0x1234567890123456789012345678901234567890';

const EXACT: MerchantExactPricing = {
  scheme: 'exact',
  network: 'eip155:84532',
  amount: '1000',
  asset: ASSET,
  payTo: PAY_TO,
  description: 'Exact work',
  resource: 'https://example.com/work',
};

const UPTO: MerchantUptoPricing = {
  scheme: 'upto',
  network: 'eip155:84532',
  maxAmount: '5000',
  minAmount: '10',
  rates: { totalPerThousand: '100' },
  unreportedUsage: 'ceiling',
  asset: ASSET,
  payTo: PAY_TO,
  description: 'Metered work',
  resource: 'https://example.com/work',
  extra: { facilitatorAddress: '0x4444444444444444444444444444444444444444' },
};

const BATCH: MerchantBatchSettlementPricing = {
  scheme: 'batch-settlement',
  network: 'eip155:84532',
  maxAmount: '5000',
  minAmount: '10',
  rates: { totalPerThousand: '100' },
  unreportedUsage: 'ceiling',
  asset: ASSET,
  payTo: PAY_TO,
  description: 'Batched metered work',
  resource: 'https://example.com/work',
  extra: {
    receiverAuthorizer: '0x6666666666666666666666666666666666666666',
    withdrawDelay: 300,
  },
};

function message(metadata?: Record<string, unknown>): Message {
  return { messageId: 'm1', role: 'user', parts: [], ...(metadata ? { metadata } : {}) };
}

function submitted(payload: X402PaymentPayload): Message {
  return message({
    [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.SUBMITTED,
    [X402_METADATA_KEYS.PAYLOAD]: payload,
  });
}

function exactPayload(): X402PaymentPayload {
  return {
    x402Version: 2,
    accepted: encodeRequirementV2(merchantPricingToAccept(EXACT)),
    payload: {
      signature: '0xsig',
      authorization: {
        from: PAYER,
        to: PAY_TO,
        value: EXACT.amount,
        validAfter: '0',
        validBefore: '9999999999',
        nonce: '0x1',
      },
    },
  };
}

function uptoPayload(cap: string = UPTO.maxAmount): X402PaymentPayload {
  return {
    x402Version: 2,
    accepted: encodeRequirementV2(merchantPricingToAccept(UPTO)),
    payload: {
      signature: '0xsig',
      permit2Authorization: {
        from: PAYER,
        permitted: { token: ASSET, amount: cap },
        spender: '0x5555555555555555555555555555555555555555',
        nonce: '0x1',
        deadline: '9999999999',
        witness: {
          to: PAY_TO,
          facilitator: '0x4444444444444444444444444444444444444444',
          validAfter: '0',
        },
      },
    },
  };
}

function batchPayload(
  type: 'voucher' | 'refund' = 'voucher',
  accepted = merchantPricingToAccept(BATCH),
): X402PaymentPayload {
  return {
    x402Version: 2,
    accepted: encodeRequirementV2(accepted),
    payload: {
      type,
      channelConfig: {
        payer: PAYER,
        payerAuthorizer: '0x7777777777777777777777777777777777777777',
        receiver: PAY_TO,
        receiverAuthorizer: '0x6666666666666666666666666666666666666666',
        token: ASSET,
        withdrawDelay: 300,
        salt: '0x01',
      },
      voucher: {
        channelId: '0xchannel',
        maxClaimableAmount: '5000',
        signature: '0xsig',
      },
    },
  };
}

function batchFixture(options: {
  pricing?: MerchantBatchSettlementPricing;
  skipHandler?: boolean;
  settleSuccess?: boolean;
} = {}) {
  const pricing = options.pricing ?? BATCH;
  const cancel = vi.fn(async () => undefined);
  const settlePayment = vi.fn(
    async (
      _payload: X402PaymentPayload,
      requirement: X402PaymentRequirements,
      _extensions?: Record<string, unknown>,
      _transport?: unknown,
      overrides?: { amount?: string },
    ) => ({
      success: options.settleSuccess ?? true,
      transaction: '',
      network: requirement.network,
      ...((options.settleSuccess ?? true) ? {} : { errorReason: 'batch settle refused' }),
      amount: '999999',
      extra: {
        chargedAmount: overrides?.amount ?? '0',
        channelState: { channelId: '0xchannel', chargedCumulativeAmount: '5000' },
      },
    }),
  );
  const resourceServer: X402ResourceServer = {
    hasRegisteredScheme: vi.fn(
      (network, scheme) => network === 'eip155:84532' && scheme === 'batch-settlement',
    ),
    buildPaymentRequirementsFromOptions: vi.fn(async (paymentOptions) =>
      paymentOptions.map((option) => ({
        scheme: option.scheme,
        network: option.network,
        amount: option.price.amount,
        asset: option.price.asset,
        payTo: option.payTo,
        maxTimeoutSeconds: option.maxTimeoutSeconds ?? 300,
        extra: { ...option.extra, withdrawDelay: 300 },
      })),
    ),
    verifyPayment: vi.fn(async () => ({
      isValid: true,
      ...(options.skipHandler
        ? {
            skipHandler: {
              contentType: 'application/json',
              body: { message: 'Refund acknowledged' },
            },
          }
        : {}),
    })),
    settlePayment,
    createPaymentCancellationDispatcher: vi.fn(() => ({ cancel })),
  };
  const x402 = new X402Context({ x402Version: 2, resourceServer });
  const gate = new MerchantGate({
    x402,
    pricing: async () => ({ accepts: [pricing] }),
    exactTiming: 'after-work',
  });
  return { gate, x402, resourceServer, cancel, settlePayment };
}

function fixture(
  offer: MerchantOffer,
  exactTiming: 'before-work' | 'after-work',
  onError?: (error: unknown, context: MerchantGateErrorContext) => void | Promise<void>,
) {
  const settledRequirements: X402PaymentRequirements[] = [];
  const facilitator: X402Facilitator = {
    verify: vi.fn(async () => ({ isValid: true })),
    settle: vi.fn(async (_payload, requirement) => {
      settledRequirements.push(requirement);
      return {
        success: true,
        transaction: '0xtx',
        network: requirement.network,
        amount: 'amount' in requirement ? requirement.amount : requirement.maxAmountRequired,
      };
    }),
  };
  const resolver = vi.fn(async () => offer);
  const x402 = new X402Context({ facilitator, x402Version: 2 });
  const gate = new MerchantGate({
    x402,
    pricing: resolver,
    exactTiming,
    ...(onError ? { onError } : {}),
  });
  return { gate, facilitator, resolver, settledRequirements, x402 };
}

describe('MerchantGate', () => {
  it('treats an explicitly undefined message as a first-turn request', async () => {
    const { gate } = fixture({ accepts: [EXACT] }, 'after-work');

    await expect(
      gate.open({
        taskId: 't-no-message',
        message: undefined,
        contextId: undefined,
        activatedExtensions: undefined,
      }),
    ).resolves.toMatchObject({ kind: 'request-payment' });
  });

  it('preserves a request-payment protocol-version refusal and rolls back the offer', async () => {
    const { gate, x402 } = fixture({ accepts: [EXACT] }, 'after-work');

    await expect(
      gate.open({
        taskId: 't-v1-only-client',
        message: message(),
        activatedExtensions: [X402_EXTENSION_URI],
      }),
    ).resolves.toMatchObject({
      kind: 'refuse',
      code: X402_ERROR_CODES.INVALID_X402_VERSION,
      reason: expect.stringContaining('V1-only client'),
    });
    await expect(gate.offerStore.getOffer('t-v1-only-client')).resolves.toBeUndefined();
    await expect(x402.store.get('t-v1-only-client')).resolves.toBeUndefined();
  });

  it('lets the host proceed when pricing returns null', async () => {
    const gate = new MerchantGate({
      x402: new X402Context({ x402Version: 2 }),
      pricing: async () => null,
      exactTiming: 'after-work',
    });
    await expect(gate.open({ taskId: 't-free', message: message() })).resolves.toEqual({
      kind: 'proceed',
    });
  });

  it('fails closed when pricing infrastructure throws', async () => {
    const onError = vi.fn();
    const infrastructureError = new Error('database unavailable at postgres://internal');
    const gate = new MerchantGate({
      x402: new X402Context({ x402Version: 2 }),
      pricing: async () => {
        throw infrastructureError;
      },
      exactTiming: 'after-work',
      onError,
    });
    await expect(gate.open({ taskId: 't-error', message: message() })).resolves.toEqual({
      kind: 'refuse',
      code: X402_ERROR_CODES.SETTLEMENT_FAILED,
      reason: 'Payment processing is unavailable.',
    });
    expect(onError).toHaveBeenCalledWith(infrastructureError, {
      operation: 'open',
      taskId: 't-error',
    });
  });

  it('applies the default offer TTL to both lifecycle stores', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-10T00:00:00Z'));
      const { gate, x402 } = fixture({ accepts: [EXACT] }, 'after-work');
      await gate.open({ taskId: 't-default-ttl', message: message() });

      expect((await gate.offerStore.getOffer('t-default-ttl'))?.expiresInSeconds).toBe(600);
      expect((await x402.store.get('t-default-ttl'))?.expiresAt).toEqual(
        new Date('2026-08-10T00:10:00Z'),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it('freezes pricing on turn 1 and settles exact after work', async () => {
    const { gate, resolver, settledRequirements, x402 } = fixture(
      { accepts: [EXACT], expiresInSeconds: 600 },
      'after-work',
    );
    const first = await gate.open({ taskId: 't-exact', message: message() });
    expect(first.kind).toBe('request-payment');

    const second = await gate.open({ taskId: 't-exact', message: submitted(exactPayload()) });
    expect(second.kind).toBe('proceed');
    if (second.kind !== 'proceed' || !second.obligation) throw new Error('missing obligation');
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(settledRequirements).toHaveLength(0);

    const settled = await gate.settle({ taskId: 't-exact', obligation: second.obligation });
    expect(settled.kind).toBe('settled');
    expect(settledRequirements).toHaveLength(1);
    await expect(gate.offerStore.getOffer('t-exact')).resolves.toBeUndefined();
    await expect(x402.store.get('t-exact')).resolves.toBeUndefined();
  });

  it('reuses frozen pricing for unpaid retries without calling the resolver again', async () => {
    const { gate, resolver } = fixture(
      { accepts: [EXACT], expiresInSeconds: 600 },
      'after-work',
    );
    await expect(
      gate.open({ taskId: 't-unpaid-retry', message: message() }),
    ).resolves.toMatchObject({ kind: 'request-payment' });
    resolver.mockRejectedValueOnce(new Error('pricing database unavailable'));

    await expect(
      gate.open({ taskId: 't-unpaid-retry', message: message() }),
    ).resolves.toMatchObject({ kind: 'request-payment' });
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('settles exact before work when configured and never settles it twice', async () => {
    const { gate, facilitator } = fixture({ accepts: [EXACT] }, 'before-work');
    await gate.open({ taskId: 't-before', message: message() });
    const opened = await gate.open({ taskId: 't-before', message: submitted(exactPayload()) });
    expect(opened.kind).toBe('proceed');
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');
    expect(opened.obligation.kind).toBe('settled');
    expect(facilitator.settle).toHaveBeenCalledTimes(1);

    await gate.settle({ taskId: 't-before', obligation: opened.obligation });
    expect(facilitator.settle).toHaveBeenCalledTimes(1);
  });

  it('lets a before-work payment flow restart after settlement is refused', async () => {
    const { gate, facilitator, x402 } = fixture({ accepts: [EXACT] }, 'before-work');
    vi.mocked(facilitator.settle).mockResolvedValueOnce({
      success: false,
      errorReason: 'facilitator rejected payment',
      network: EXACT.network,
    });
    await gate.open({ taskId: 't-before-retry', message: message() });

    await expect(
      gate.open({ taskId: 't-before-retry', message: submitted(exactPayload()) }),
    ).resolves.toMatchObject({
      kind: 'refuse',
      code: X402_ERROR_CODES.SETTLEMENT_FAILED,
      reason: 'facilitator rejected payment',
    });
    await expect(gate.offerStore.getOffer('t-before-retry')).resolves.toBeUndefined();
    await expect(x402.store.get('t-before-retry')).resolves.toBeUndefined();
    await expect(
      gate.open({ taskId: 't-before-retry', message: message() }),
    ).resolves.toMatchObject({ kind: 'request-payment' });
  });

  it('rejects a replay through the one-shot claim', async () => {
    const { gate } = fixture({ accepts: [EXACT] }, 'after-work');
    await gate.open({ taskId: 't-replay', message: message() });
    await gate.open({ taskId: 't-replay', message: submitted(exactPayload()) });
    const replay = await gate.open({ taskId: 't-replay', message: submitted(exactPayload()) });
    expect(replay).toMatchObject({
      kind: 'refuse',
      code: X402_ERROR_CODES.DUPLICATE_NONCE,
    });
  });

  it('allows retry after verification fails before claiming execution', async () => {
    const { gate, facilitator } = fixture({ accepts: [EXACT] }, 'after-work');
    vi.mocked(facilitator.verify)
      .mockResolvedValueOnce({ isValid: false, invalidReason: 'facilitator temporarily unavailable' })
      .mockResolvedValueOnce({ isValid: true });
    await gate.open({ taskId: 't-verify-retry', message: message() });

    await expect(
      gate.open({ taskId: 't-verify-retry', message: submitted(exactPayload()) }),
    ).resolves.toMatchObject({ kind: 'refuse' });
    await expect(
      gate.open({ taskId: 't-verify-retry', message: submitted(exactPayload()) }),
    ).resolves.toMatchObject({ kind: 'proceed' });
  });

  it('keeps requested and facilitator-confirmed settlement amounts', async () => {
    const { gate, facilitator } = fixture({ accepts: [EXACT] }, 'after-work');
    vi.mocked(facilitator.settle).mockResolvedValueOnce({
      success: true,
      transaction: '0xtx',
      network: EXACT.network,
      amount: '900',
    });
    await gate.open({ taskId: 't-reconcile', message: message() });
    const opened = await gate.open({ taskId: 't-reconcile', message: submitted(exactPayload()) });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');

    await expect(
      gate.settle({ taskId: 't-reconcile', obligation: opened.obligation }),
    ).resolves.toMatchObject({
      kind: 'settled',
      charge: { requestedAtomic: '1000', amountAtomic: '900', basis: 'exact' },
    });
  });

  it('hides settlement exceptions and reports them to the host', async () => {
    const onError = vi.fn();
    const settlementError = new Error('facilitator token leaked here');
    const { gate, x402 } = fixture({ accepts: [EXACT] }, 'after-work', onError);
    await gate.open({ taskId: 't-settle-error', message: message() });
    const opened = await gate.open({
      taskId: 't-settle-error',
      message: submitted(exactPayload()),
    });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');
    vi.spyOn(x402, 'settle').mockRejectedValueOnce(settlementError);

    await expect(
      gate.settle({ taskId: 't-settle-error', obligation: opened.obligation }),
    ).resolves.toEqual({
      kind: 'failed',
      code: X402_ERROR_CODES.SETTLEMENT_FAILED,
      reason: 'Payment settlement failed.',
    });
    expect(onError).toHaveBeenCalledWith(settlementError, {
      operation: 'settle',
      taskId: 't-settle-error',
    });
  });

  it('keeps a successful settlement successful when cleanup fails', async () => {
    const onError = vi.fn();
    const cleanupError = new Error('offer store cleanup failed');
    const { gate, x402 } = fixture({ accepts: [EXACT] }, 'after-work', onError);
    await gate.open({ taskId: 't-cleanup-error', message: message() });
    const opened = await gate.open({
      taskId: 't-cleanup-error',
      message: submitted(exactPayload()),
    });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');
    vi.spyOn(gate.offerStore, 'delete').mockRejectedValueOnce(cleanupError);

    await expect(
      gate.settle({ taskId: 't-cleanup-error', obligation: opened.obligation }),
    ).resolves.toMatchObject({ kind: 'settled' });
    expect(onError).toHaveBeenCalledWith(cleanupError, {
      operation: 'cleanup',
      taskId: 't-cleanup-error',
    });
    await expect(x402.store.get('t-cleanup-error')).resolves.toBeUndefined();
  });

  it('applies the required unreported-usage policy to upto', async () => {
    const { gate, settledRequirements } = fixture({ accepts: [UPTO] }, 'after-work');
    await gate.open({ taskId: 't-upto', message: message() });
    const opened = await gate.open({ taskId: 't-upto', message: submitted(uptoPayload()) });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');

    const result = await gate.settle({
      taskId: 't-upto',
      obligation: opened.obligation,
      usage: { kind: 'unreported' },
    });
    expect(result).toMatchObject({
      kind: 'settled',
      charge: { amountAtomic: UPTO.maxAmount, basis: 'unreported-ceiling' },
    });
    expect((settledRequirements[0] as { amount: string }).amount).toBe(UPTO.maxAmount);
  });

  it('reports the charge clamped to the payer signed cap', async () => {
    const { gate, settledRequirements } = fixture({ accepts: [UPTO] }, 'after-work');
    await gate.open({ taskId: 't-cap', message: message() });
    const opened = await gate.open({ taskId: 't-cap', message: submitted(uptoPayload('2000')) });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');

    const result = await gate.settle({
      taskId: 't-cap',
      obligation: opened.obligation,
      usage: { kind: 'unreported' },
    });
    expect(result).toMatchObject({
      kind: 'settled',
      charge: { amountAtomic: '2000', basis: 'unreported-ceiling' },
    });
    expect((settledRequirements[0] as { amount: string }).amount).toBe('2000');
  });

  it('supports floor and refuse policies for unpriceable usage', async () => {
    const floorPricing: MerchantUptoPricing = { ...UPTO, unreportedUsage: 'floor' };
    const floorFixture = fixture({ accepts: [floorPricing] }, 'after-work');
    await floorFixture.gate.open({ taskId: 't-floor', message: message() });
    const floorOpened = await floorFixture.gate.open({
      taskId: 't-floor',
      message: submitted(uptoPayload()),
    });
    if (floorOpened.kind !== 'proceed' || !floorOpened.obligation) {
      throw new Error('missing floor obligation');
    }
    await expect(
      floorFixture.gate.settle({
        taskId: 't-floor',
        obligation: floorOpened.obligation,
        usage: { kind: 'unreported' },
      }),
    ).resolves.toMatchObject({
      kind: 'settled',
      charge: { amountAtomic: UPTO.minAmount, basis: 'unreported-floor' },
    });

    const refusePricing: MerchantUptoPricing = { ...UPTO, unreportedUsage: 'refuse' };
    const refuseFixture = fixture({ accepts: [refusePricing] }, 'after-work');
    await refuseFixture.gate.open({ taskId: 't-refuse', message: message() });
    const refuseOpened = await refuseFixture.gate.open({
      taskId: 't-refuse',
      message: submitted(uptoPayload()),
    });
    if (refuseOpened.kind !== 'proceed' || !refuseOpened.obligation) {
      throw new Error('missing refuse obligation');
    }
    await expect(
      refuseFixture.gate.settle({
        taskId: 't-refuse',
        obligation: refuseOpened.obligation,
        usage: { kind: 'unreported' },
      }),
    ).resolves.toMatchObject({
      kind: 'failed',
      code: X402_ERROR_CODES.SETTLEMENT_FAILED,
    });
    expect(refuseFixture.facilitator.settle).not.toHaveBeenCalled();
  });

  it('meters and commits a batch-settlement charge through the resource server', async () => {
    const { gate, x402, resourceServer, settlePayment } = batchFixture();
    await gate.open({ taskId: 't-batch', message: message() });
    const storedOffer = await x402.store.get('t-batch');
    expect(storedOffer?.accepts[0]?.extra).toMatchObject({ withdrawDelay: 300 });

    const opened = await gate.open({
      taskId: 't-batch',
      message: submitted(batchPayload('voucher', storedOffer!.accepts[0]!)),
    });
    expect(opened.kind).toBe('proceed');
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');
    expect(opened.obligation).toMatchObject({ kind: 'deferred', scheme: 'batch-settlement' });

    const settled = await gate.settle({
      taskId: 't-batch',
      obligation: opened.obligation,
      usage: { kind: 'total', totalTokens: 1_500 },
    });
    expect(settled).toMatchObject({
      kind: 'settled',
      charge: { requestedAtomic: '150', amountAtomic: '150', basis: 'metered' },
      receipt: {
        transaction: '',
        amount: '150',
        extra: { channelState: { channelId: '0xchannel' } },
      },
    });
    expect(settlePayment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      undefined,
      { amount: '150' },
    );
    expect(resourceServer.createPaymentCancellationDispatcher).toHaveBeenCalledOnce();
    await expect(gate.offerStore.getOffer('t-batch')).resolves.toBeUndefined();
    await expect(x402.store.get('t-batch')).resolves.toMatchObject({
      status: 'completed',
      receipt: { amount: '150', extra: { channelState: { channelId: '0xchannel' } } },
    });
  });

  it('cancels a batch reservation and releases the task claim for retry', async () => {
    const { gate, x402, cancel, resourceServer } = batchFixture();
    await gate.open({ taskId: 't-batch-abort', message: message() });
    const accepted = (await x402.store.get('t-batch-abort'))!.accepts[0]!;
    const first = await gate.open({
      taskId: 't-batch-abort',
      message: submitted(batchPayload('voucher', accepted)),
    });
    if (first.kind !== 'proceed' || !first.obligation) throw new Error('missing obligation');

    await gate.abort({
      taskId: 't-batch-abort',
      obligation: first.obligation,
      reason: 'handler_threw',
      error: new Error('work failed'),
    });
    expect(cancel).toHaveBeenCalledWith(
      expect.objectContaining({ reason: 'handler_threw', error: expect.any(Error) }),
    );

    await expect(
      gate.open({
        taskId: 't-batch-abort',
        message: submitted(batchPayload('voucher', accepted)),
      }),
    ).resolves.toMatchObject({
      kind: 'proceed',
      obligation: { scheme: 'batch-settlement' },
    });
    expect(resourceServer.verifyPayment).toHaveBeenCalledTimes(2);
  });

  it('cancels batch state when usage policy refuses settlement', async () => {
    const { gate, x402, cancel, settlePayment } = batchFixture({
      pricing: { ...BATCH, unreportedUsage: 'refuse' },
    });
    await gate.open({ taskId: 't-batch-unpriced', message: message() });
    const accepted = (await x402.store.get('t-batch-unpriced'))!.accepts[0]!;
    const opened = await gate.open({
      taskId: 't-batch-unpriced',
      message: submitted(batchPayload('voucher', accepted)),
    });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');

    await expect(
      gate.settle({
        taskId: 't-batch-unpriced',
        obligation: opened.obligation,
        usage: { kind: 'unreported' },
      }),
    ).resolves.toMatchObject({ kind: 'failed' });
    expect(settlePayment).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledWith({ reason: 'handler_failed' });

    await expect(
      gate.open({
        taskId: 't-batch-unpriced',
        message: submitted(batchPayload('voucher', accepted)),
      }),
    ).resolves.toMatchObject({ kind: 'proceed' });
  });

  it('settles a batch refund without allowing resource work to run', async () => {
    const { gate, x402, settlePayment, resourceServer } = batchFixture({ skipHandler: true });
    await gate.open({ taskId: 't-batch-refund', message: message() });
    const accepted = (await x402.store.get('t-batch-refund'))!.accepts[0]!;

    await expect(
      gate.open({
        taskId: 't-batch-refund',
        message: submitted(batchPayload('refund', accepted)),
      }),
    ).resolves.toMatchObject({
      kind: 'handled',
      operation: 'batch-refund',
      response: { body: { message: 'Refund acknowledged' } },
      receipt: { success: true },
    });
    expect(resourceServer.createPaymentCancellationDispatcher).toHaveBeenCalledOnce();
    expect(settlePayment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      undefined,
      undefined,
      undefined,
    );
    await expect(x402.store.get('t-batch-refund')).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('cancels a refund reservation when its immediate settlement is refused', async () => {
    const { gate, x402, cancel } = batchFixture({
      skipHandler: true,
      settleSuccess: false,
    });
    await gate.open({ taskId: 't-batch-refund-failed', message: message() });
    const accepted = (await x402.store.get('t-batch-refund-failed'))!.accepts[0]!;

    await expect(
      gate.open({
        taskId: 't-batch-refund-failed',
        message: submitted(batchPayload('refund', accepted)),
      }),
    ).resolves.toMatchObject({
      kind: 'refuse',
      reason: 'batch settle refused',
    });
    expect(cancel).toHaveBeenCalledWith({ reason: 'handler_failed' });

    await expect(
      gate.open({
        taskId: 't-batch-refund-failed',
        message: submitted(batchPayload('refund', accepted)),
      }),
    ).resolves.toMatchObject({ kind: 'refuse', reason: 'batch settle refused' });
  });

  it('fails closed before publishing batch terms without a registered resource server', async () => {
    const onError = vi.fn();
    const gate = new MerchantGate({
      x402: new X402Context({ x402Version: 2 }),
      pricing: async () => ({ accepts: [BATCH] }),
      exactTiming: 'after-work',
      onError,
    });

    await expect(
      gate.open({ taskId: 't-batch-missing-server', message: message() }),
    ).resolves.toEqual({
      kind: 'refuse',
      code: X402_ERROR_CODES.SETTLEMENT_FAILED,
      reason: 'Payment processing is unavailable.',
    });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('resource server') }),
      { operation: 'open', taskId: 't-batch-missing-server' },
    );
  });
});
