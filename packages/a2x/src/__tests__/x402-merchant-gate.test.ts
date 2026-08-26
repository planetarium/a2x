import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../types/common.js';
import {
  InMemoryMerchantOfferStore,
  InMemoryX402Store,
  MerchantGate,
  merchantPricingToAccept,
  type MerchantBatchSettlementPricing,
  type MerchantDeliveryMetadataBuilder,
  type MerchantDeliveryTiming,
  type MerchantExactPricing,
  type MerchantGateErrorContext,
  type MerchantOffer,
  type MerchantOfferStore,
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

class SharedStoreWithoutDeleteOffer
  extends InMemoryX402Store
  implements MerchantOfferStore {
  private readonly offers = new InMemoryMerchantOfferStore();

  publishing<T>(
    taskId: string,
    offer: MerchantOffer,
    publish: (frozenOffer: MerchantOffer) => Promise<T>,
  ): Promise<T> {
    return this.offers.publishing(taskId, offer, publish);
  }

  getOffer(taskId: string): Promise<MerchantOffer | undefined> {
    return this.offers.getOffer(taskId);
  }

  getClaimStatus(taskId: string) {
    return this.offers.getClaimStatus(taskId);
  }

  claim(taskId: string): Promise<boolean> {
    return this.offers.claim(taskId);
  }

  release(taskId: string): Promise<void> {
    return this.offers.release(taskId);
  }

  override async delete(taskId: string): Promise<void> {
    await Promise.all([super.delete(taskId), this.offers.delete(taskId)]);
  }
}

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
  deliveryTiming?: MerchantDeliveryTiming;
  cancelFailure?: Error;
  onError?: (error: unknown, context: MerchantGateErrorContext) => void | Promise<void>;
  deliveryMetadata?: MerchantDeliveryMetadataBuilder;
} = {}) {
  const pricing = options.pricing ?? BATCH;
  const cancel = vi.fn(async () => {
    if (options.cancelFailure) throw options.cancelFailure;
  });
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
    deliveryTiming: options.deliveryTiming ?? 'after-settlement',
    ...(options.onError ? { onError: options.onError } : {}),
    ...(options.deliveryMetadata ? { deliveryMetadata: options.deliveryMetadata } : {}),
  });
  return { gate, x402, resourceServer, cancel, settlePayment };
}

function fixture(
  offer: MerchantOffer,
  exactTiming: 'before-work' | 'after-work',
  onError?: (error: unknown, context: MerchantGateErrorContext) => void | Promise<void>,
  deliveryTiming: MerchantDeliveryTiming = 'after-settlement',
  deliveryMetadata?: MerchantDeliveryMetadataBuilder,
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
    deliveryTiming,
    ...(deliveryMetadata ? { deliveryMetadata } : {}),
    ...(onError ? { onError } : {}),
  });
  return { gate, facilitator, resolver, settledRequirements, x402 };
}

describe('MerchantGate', () => {
  it('requires an explicit delivery timing policy', () => {
    expect(
      () =>
        new MerchantGate({
          x402: new X402Context({ x402Version: 2 }),
          pricing: async () => null,
          exactTiming: 'after-work',
          deliveryTiming: undefined as never,
        }),
    ).toThrow("deliveryTiming must be 'after-settlement' or 'after-verification'");
  });

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
      deliveryTiming: 'after-settlement',
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
      deliveryTiming: 'after-settlement',
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
    await expect(x402.store.get('t-exact')).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('blocks fail-closed delivery until settlement and then authorizes final metadata', async () => {
    const deliveryMetadata = vi.fn(
      ({ provisional }: { provisional: boolean }) => ({
        'merchant.example/delivery': provisional ? 'provisional' : 'final',
      }),
    );
    const { gate, x402 } = fixture(
      { accepts: [EXACT] },
      'after-work',
      undefined,
      'after-settlement',
      deliveryMetadata,
    );
    await gate.open({ taskId: 't-buffered', message: message() });
    const opened = await gate.open({
      taskId: 't-buffered',
      message: submitted(exactPayload()),
    });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');

    await expect(gate.authorizeDelivery({ taskId: 't-buffered' })).resolves.toEqual({
      kind: 'blocked',
      reason: 'settlement-required',
    });
    await gate.settle({ taskId: 't-buffered', obligation: opened.obligation });
    await expect(gate.authorizeDelivery({ taskId: 't-buffered' })).resolves.toEqual({
      kind: 'authorized',
      provisional: false,
      metadata: { 'merchant.example/delivery': 'final' },
    });
    expect(deliveryMetadata).toHaveBeenCalledWith({
      taskId: 't-buffered',
      timing: 'after-settlement',
      provisional: false,
      paymentStatus: 'settled',
    });
    await expect(x402.store.get('t-buffered')).resolves.toMatchObject({
      status: 'completed',
      merchantDelivery: {
        timing: 'after-settlement',
        publicationStartedAt: expect.any(Date),
        workCompletedAt: expect.any(Date),
      },
    });
  });

  it('authorizes provisional delivery after verification and records it before publication', async () => {
    const { gate, x402 } = fixture(
      { accepts: [EXACT] },
      'after-work',
      undefined,
      'after-verification',
      ({ provisional }) => ({ provisional }),
    );
    await gate.open({ taskId: 't-progressive', message: message() });
    const opened = await gate.open({
      taskId: 't-progressive',
      message: submitted(exactPayload()),
    });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');

    await expect(gate.authorizeDelivery({ taskId: 't-progressive' })).resolves.toEqual({
      kind: 'authorized',
      provisional: true,
      metadata: { provisional: true },
    });
    await expect(x402.store.get('t-progressive')).resolves.toMatchObject({
      status: 'verified',
      merchantDelivery: {
        timing: 'after-verification',
        publicationStartedAt: expect.any(Date),
      },
    });
  });

  it('blocks delivery when settlement fails while metadata is being prepared', async () => {
    let releaseMetadata!: () => void;
    const metadataBlocked = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    const metadataStarted = vi.fn();
    const { gate, x402 } = fixture(
      { accepts: [EXACT] },
      'after-work',
      undefined,
      'after-verification',
      async () => {
        metadataStarted();
        await metadataBlocked;
        return { provisional: true };
      },
    );
    await gate.open({ taskId: 't-delivery-failed-race', message: message() });
    await gate.open({
      taskId: 't-delivery-failed-race',
      message: submitted(exactPayload()),
    });

    const delivery = gate.authorizeDelivery({ taskId: 't-delivery-failed-race' });
    await vi.waitFor(() => expect(metadataStarted).toHaveBeenCalledOnce());
    await x402.store.updateIfStatus('t-delivery-failed-race', ['verified'], {
      status: 'failed',
      failure: {
        point: 'settle',
        code: X402_ERROR_CODES.SETTLEMENT_FAILED,
        reason: 'settlement refused',
        failedAt: new Date(),
      },
    });
    releaseMetadata();

    await expect(delivery).resolves.toEqual({ kind: 'blocked', reason: 'payment-failed' });
    await expect(x402.store.get('t-delivery-failed-race')).resolves.toMatchObject({
      status: 'failed',
    });
    await expect(gate.publicationStarted('t-delivery-failed-race')).resolves.toBe(false);
  });

  it('blocks delivery when its atomic publication deadline passes during metadata work', async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-08-11T00:00:00Z'));
      let releaseMetadata!: () => void;
      const metadataBlocked = new Promise<void>((resolve) => {
        releaseMetadata = resolve;
      });
      const metadataStarted = vi.fn();
      const { gate } = fixture(
        { accepts: [EXACT] },
        'after-work',
        undefined,
        'after-verification',
        async () => {
          metadataStarted();
          await metadataBlocked;
          return { provisional: true };
        },
      );
      await gate.open({ taskId: 't-delivery-deadline', message: message() });
      await gate.open({
        taskId: 't-delivery-deadline',
        message: submitted(exactPayload()),
      });

      const delivery = gate.authorizeDelivery({
        taskId: 't-delivery-deadline',
        notAfter: new Date('2026-08-11T00:00:01Z'),
      });
      await vi.waitFor(() => expect(metadataStarted).toHaveBeenCalledOnce());
      vi.setSystemTime(new Date('2026-08-11T00:00:02Z'));
      releaseMetadata();

      await expect(delivery).resolves.toEqual({
        kind: 'blocked',
        reason: 'payment-state-unavailable',
      });
      await expect(gate.publicationStarted('t-delivery-deadline')).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('linearizes publication against a concurrent lapse', async () => {
    const { gate, x402 } = fixture(
      { accepts: [EXACT] },
      'after-work',
      undefined,
      'after-verification',
    );
    await gate.open({ taskId: 't-delivery-lapse-race', message: message() });
    await gate.open({
      taskId: 't-delivery-lapse-race',
      message: submitted(exactPayload()),
    });

    let releaseClosure!: () => void;
    let closureStarted!: () => void;
    const closureBlocked = new Promise<void>((resolve) => {
      releaseClosure = resolve;
    });
    const closureObserved = new Promise<void>((resolve) => {
      closureStarted = resolve;
    });
    const updateMerchantDeliveryIfStatus =
      x402.store.updateMerchantDeliveryIfStatus.bind(x402.store);
    vi.spyOn(x402.store, 'updateMerchantDeliveryIfStatus').mockImplementation(
      async (taskId, expected, patch, condition) => {
        if (patch.publicationClosedAt) {
          closureStarted();
          await closureBlocked;
        }
        return await updateMerchantDeliveryIfStatus(taskId, expected, patch, condition);
      },
    );

    const lapse = gate.lapse('t-delivery-lapse-race');
    await closureObserved;
    await expect(
      gate.authorizeDelivery({ taskId: 't-delivery-lapse-race' }),
    ).resolves.toMatchObject({ kind: 'authorized' });
    releaseClosure();

    await expect(lapse).rejects.toThrow(
      'cannot lapse an authorization after content publication',
    );
    await expect(x402.store.get('t-delivery-lapse-race')).resolves.toMatchObject({
      status: 'verified',
      merchantDelivery: { publicationStartedAt: expect.any(Date) },
    });
  });

  it('fails lapse when cleanup only partially removes durable state', async () => {
    const { gate, x402 } = fixture(
      { accepts: [EXACT] },
      'after-work',
      undefined,
      'after-verification',
    );
    await gate.open({ taskId: 't-lapse-cleanup-failure', message: message() });
    await gate.open({
      taskId: 't-lapse-cleanup-failure',
      message: submitted(exactPayload()),
    });
    vi.spyOn(gate.offerStore, 'delete').mockRejectedValueOnce(new Error('redis unavailable'));

    await expect(gate.lapse('t-lapse-cleanup-failure')).rejects.toThrow(
      'cleanup did not complete',
    );
    await expect(gate.offerStore.getClaimStatus?.('t-lapse-cleanup-failure')).resolves.toBe(
      'claimed',
    );
    await expect(x402.store.get('t-lapse-cleanup-failure')).resolves.toBeUndefined();
  });

  it('blocks delivery when the publication boundary cannot be persisted', async () => {
    const { gate, x402 } = fixture(
      { accepts: [EXACT] },
      'after-work',
      undefined,
      'after-verification',
    );
    await gate.open({ taskId: 't-delivery-store-failure', message: message() });
    await gate.open({
      taskId: 't-delivery-store-failure',
      message: submitted(exactPayload()),
    });
    vi.spyOn(x402.store, 'updateMerchantDeliveryIfStatus').mockResolvedValue(undefined);

    await expect(
      gate.authorizeDelivery({ taskId: 't-delivery-store-failure' }),
    ).resolves.toEqual({
      kind: 'blocked',
      reason: 'payment-state-unavailable',
    });
    await expect(gate.publicationStarted('t-delivery-store-failure')).resolves.toBe(false);
  });

  it('does not rebuild metadata for repeated races in the same payment phase', async () => {
    const deliveryMetadata = vi.fn(() => ({ provisional: true }));
    const { gate, x402 } = fixture(
      { accepts: [EXACT] },
      'after-work',
      undefined,
      'after-verification',
      deliveryMetadata,
    );
    await gate.open({ taskId: 't-delivery-metadata-retry', message: message() });
    await gate.open({
      taskId: 't-delivery-metadata-retry',
      message: submitted(exactPayload()),
    });
    vi.spyOn(x402.store, 'updateMerchantDeliveryIfStatus').mockResolvedValue(undefined);

    await expect(
      gate.authorizeDelivery({ taskId: 't-delivery-metadata-retry' }),
    ).resolves.toEqual({ kind: 'blocked', reason: 'payment-state-unavailable' });
    expect(deliveryMetadata).toHaveBeenCalledOnce();
  });

  it('merges concurrent publication and settlement audit fields', async () => {
    const { gate, x402 } = fixture(
      { accepts: [EXACT] },
      'after-work',
      undefined,
      'after-verification',
    );
    await gate.open({ taskId: 't-delivery-settle-race', message: message() });
    const opened = await gate.open({
      taskId: 't-delivery-settle-race',
      message: submitted(exactPayload()),
    });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');

    const [delivery, settlement] = await Promise.all([
      gate.authorizeDelivery({ taskId: 't-delivery-settle-race' }),
      gate.settle({ taskId: 't-delivery-settle-race', obligation: opened.obligation }),
    ]);

    expect(delivery).toMatchObject({ kind: 'authorized' });
    expect(settlement).toMatchObject({ kind: 'settled' });
    await expect(x402.store.get('t-delivery-settle-race')).resolves.toMatchObject({
      status: 'completed',
      merchantDelivery: {
        publicationStartedAt: expect.any(Date),
        workCompletedAt: expect.any(Date),
      },
    });
  });

  it('settles exact work that fails after provisional content was published', async () => {
    const { gate, facilitator, x402 } = fixture(
      { accepts: [EXACT] },
      'after-work',
      undefined,
      'after-verification',
    );
    await gate.open({ taskId: 't-partial-exact-failure', message: message() });
    const opened = await gate.open({
      taskId: 't-partial-exact-failure',
      message: submitted(exactPayload()),
    });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');
    await gate.authorizeDelivery({ taskId: 't-partial-exact-failure' });

    await expect(
      gate.abort({
        taskId: 't-partial-exact-failure',
        obligation: opened.obligation,
        reason: 'handler_threw',
        error: new Error('upstream failed'),
      }),
    ).resolves.toMatchObject({
      kind: 'settled',
      charge: { requestedAtomic: '1000', basis: 'exact' },
    });
    expect(facilitator.settle).toHaveBeenCalledOnce();
    await expect(x402.store.get('t-partial-exact-failure')).resolves.toMatchObject({
      status: 'completed',
      merchantDelivery: {
        publicationStartedAt: expect.any(Date),
        workFailedAt: expect.any(Date),
      },
    });
  });

  it('still settles published work when work-audit persistence fails', async () => {
    const onError = vi.fn();
    const { gate, facilitator, x402 } = fixture(
      { accepts: [EXACT] },
      'after-work',
      onError,
      'after-verification',
    );
    await gate.open({ taskId: 't-published-audit-failure', message: message() });
    const opened = await gate.open({
      taskId: 't-published-audit-failure',
      message: submitted(exactPayload()),
    });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');
    await gate.authorizeDelivery({ taskId: 't-published-audit-failure' });
    vi.spyOn(x402.store, 'updateMerchantDelivery').mockResolvedValueOnce(false);

    await expect(
      gate.abort({
        taskId: 't-published-audit-failure',
        obligation: opened.obligation,
        reason: 'handler_threw',
      }),
    ).resolves.toMatchObject({ kind: 'settled' });
    expect(facilitator.settle).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), {
      operation: 'settle',
      taskId: 't-published-audit-failure',
    });
  });

  it('settles metered usage when upto work fails after provisional delivery', async () => {
    const { gate } = fixture(
      { accepts: [UPTO] },
      'after-work',
      undefined,
      'after-verification',
    );
    await gate.open({ taskId: 't-partial-upto-failure', message: message() });
    const opened = await gate.open({
      taskId: 't-partial-upto-failure',
      message: submitted(uptoPayload()),
    });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');
    await gate.authorizeDelivery({ taskId: 't-partial-upto-failure' });

    await expect(
      gate.abort({
        taskId: 't-partial-upto-failure',
        obligation: opened.obligation,
        reason: 'handler_threw',
        usage: { kind: 'total', totalTokens: 1_500 },
      }),
    ).resolves.toMatchObject({
      kind: 'settled',
      charge: { requestedAtomic: '150', basis: 'metered' },
    });
  });

  it('does not settle failed after-work execution when no content was published', async () => {
    const { gate, facilitator, x402 } = fixture(
      { accepts: [EXACT] },
      'after-work',
      undefined,
      'after-verification',
    );
    await gate.open({ taskId: 't-undelivered-failure', message: message() });
    const opened = await gate.open({
      taskId: 't-undelivered-failure',
      message: submitted(exactPayload()),
    });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');

    await expect(
      gate.abort({
        taskId: 't-undelivered-failure',
        obligation: opened.obligation,
        reason: 'handler_threw',
      }),
    ).resolves.toEqual({ kind: 'aborted' });
    expect(facilitator.settle).not.toHaveBeenCalled();
    await expect(x402.store.get('t-undelivered-failure')).resolves.toBeUndefined();
  });

  it('refuses to lapse an authorization after publication', async () => {
    const { gate } = fixture(
      { accepts: [UPTO] },
      'after-work',
      undefined,
      'after-verification',
    );
    await gate.open({ taskId: 't-published-lapse', message: message() });
    await gate.open({ taskId: 't-published-lapse', message: submitted(uptoPayload()) });
    await gate.authorizeDelivery({ taskId: 't-published-lapse' });

    await expect(gate.lapse('t-published-lapse')).rejects.toThrow(
      'cannot lapse an authorization after content publication',
    );
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

  it('treats before-work exact delivery as final under either delivery policy', async () => {
    const { gate } = fixture(
      { accepts: [EXACT] },
      'before-work',
      undefined,
      'after-verification',
    );
    await gate.open({ taskId: 't-before-progressive', message: message() });
    await gate.open({
      taskId: 't-before-progressive',
      message: submitted(exactPayload()),
    });

    await expect(
      gate.authorizeDelivery({ taskId: 't-before-progressive' }),
    ).resolves.toMatchObject({
      kind: 'authorized',
      provisional: false,
    });
  });

  it('lapses a held authorization without settlement', async () => {
    const { gate, facilitator, x402 } = fixture({ accepts: [UPTO] }, 'after-work');
    await gate.open({ taskId: 't-lapse', message: message() });
    const opened = await gate.open({ taskId: 't-lapse', message: submitted(uptoPayload()) });
    expect(opened).toMatchObject({ kind: 'proceed', obligation: { scheme: 'upto' } });

    await gate.lapse('t-lapse');

    expect(facilitator.settle).not.toHaveBeenCalled();
    await expect(gate.offerStore.getOffer('t-lapse')).resolves.toBeUndefined();
    await expect(x402.store.get('t-lapse')).resolves.toBeUndefined();
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
    const { gate, facilitator } = fixture({ accepts: [EXACT] }, 'after-work');
    await gate.open({ taskId: 't-replay', message: message() });
    await gate.open({ taskId: 't-replay', message: submitted(exactPayload()) });
    const replay = await gate.open({ taskId: 't-replay', message: submitted(exactPayload()) });
    expect(replay).toMatchObject({
      kind: 'refuse',
      code: X402_ERROR_CODES.DUPLICATE_NONCE,
    });
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
  });

  it('uses the atomic claim after concurrent verification as the arbiter', async () => {
    const { gate, facilitator } = fixture({ accepts: [EXACT] }, 'after-work');
    await gate.open({ taskId: 't-concurrent', message: message() });

    const outcomes = await Promise.all([
      gate.open({ taskId: 't-concurrent', message: submitted(exactPayload()) }),
      gate.open({ taskId: 't-concurrent', message: submitted(exactPayload()) }),
    ]);
    expect(outcomes.filter((outcome) => outcome.kind === 'proceed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.kind === 'refuse')).toHaveLength(1);
    expect(facilitator.verify).toHaveBeenCalledTimes(2);
  });

  it('does not let a late concurrent verify regress completed lifecycle state', async () => {
    const { gate, facilitator, x402 } = fixture({ accepts: [EXACT] }, 'before-work');
    let releaseLateVerify!: () => void;
    const lateVerify = new Promise<void>((resolve) => {
      releaseLateVerify = resolve;
    });
    let verificationCount = 0;
    vi.mocked(facilitator.verify).mockImplementation(async () => {
      verificationCount += 1;
      if (verificationCount === 2) await lateVerify;
      return { isValid: true };
    });
    await gate.open({ taskId: 't-late-verify', message: message() });

    const winner = gate.open({ taskId: 't-late-verify', message: submitted(exactPayload()) });
    const loser = gate.open({ taskId: 't-late-verify', message: submitted(exactPayload()) });
    await expect(winner).resolves.toMatchObject({
      kind: 'proceed',
      obligation: { kind: 'settled' },
    });
    releaseLateVerify();
    await expect(loser).resolves.toMatchObject({
      kind: 'refuse',
      code: X402_ERROR_CODES.DUPLICATE_NONCE,
    });
    await expect(x402.store.get('t-late-verify')).resolves.toMatchObject({
      status: 'completed',
      receipt: { transaction: '0xtx' },
    });
  });

  it('recovers a crash after verification but before the execution claim', async () => {
    const { gate, facilitator, x402 } = fixture({ accepts: [EXACT] }, 'after-work');
    await gate.open({ taskId: 't-verified-recovery', message: message() });
    const classified = await x402.classify({
      taskId: 't-verified-recovery',
      message: submitted(exactPayload()),
    });
    if (classified.kind !== 'valid') throw new Error('expected valid');
    await x402.verify({ taskId: 't-verified-recovery' }, classified);

    await expect(
      gate.open({ taskId: 't-verified-recovery', message: submitted(exactPayload()) }),
    ).resolves.toMatchObject({ kind: 'proceed' });
    expect(facilitator.verify).toHaveBeenCalledTimes(2);
  });

  it('keeps a claimed verified attempt terminal across gate reconstruction', async () => {
    const { gate, facilitator, x402 } = fixture({ accepts: [EXACT] }, 'after-work');
    await gate.open({ taskId: 't-claimed-restart', message: message() });
    await gate.open({ taskId: 't-claimed-restart', message: submitted(exactPayload()) });

    const restarted = new MerchantGate({
      x402,
      offerStore: gate.offerStore,
      pricing: async () => ({ accepts: [EXACT] }),
      exactTiming: 'after-work',
      deliveryTiming: 'after-settlement',
    });
    await expect(
      restarted.open({ taskId: 't-claimed-restart', message: submitted(exactPayload()) }),
    ).resolves.toMatchObject({
      kind: 'refuse',
      code: X402_ERROR_CODES.DUPLICATE_NONCE,
    });
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
  });

  it('keeps a client-rejected task terminal', async () => {
    const { gate, facilitator } = fixture({ accepts: [EXACT] }, 'after-work');
    await gate.open({ taskId: 't-rejected', message: message() });
    await expect(
      gate.open({
        taskId: 't-rejected',
        message: message({
          [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REJECTED,
        }),
      }),
    ).resolves.toMatchObject({ kind: 'refuse', reason: 'Client declined to pay.' });

    await expect(
      gate.open({ taskId: 't-rejected', message: submitted(exactPayload()) }),
    ).resolves.toMatchObject({ kind: 'refuse', reason: 'Client declined to pay.' });
    expect(facilitator.verify).not.toHaveBeenCalled();
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

  it('keeps an indeterminate before-work settlement claimed for reconciliation', async () => {
    const onError = vi.fn();
    const { gate, facilitator, x402 } = fixture(
      { accepts: [EXACT] },
      'before-work',
      onError,
    );
    vi.mocked(facilitator.settle).mockRejectedValueOnce(new Error('connection lost'));
    await gate.open({ taskId: 't-indeterminate', message: message() });

    await expect(
      gate.open({ taskId: 't-indeterminate', message: submitted(exactPayload()) }),
    ).resolves.toMatchObject({
      kind: 'refuse',
      reason: 'Payment settlement outcome is unavailable.',
    });
    await expect(x402.store.get('t-indeterminate')).resolves.toMatchObject({
      status: 'failed',
      failure: { point: 'settle', indeterminate: true },
    });
    await expect(gate.offerStore.getClaimStatus?.('t-indeterminate')).resolves.toBe(
      'claimed',
    );
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'connection lost' }), {
      operation: 'open',
      taskId: 't-indeterminate',
    });

    await expect(
      gate.open({ taskId: 't-indeterminate', message: submitted(exactPayload()) }),
    ).resolves.toMatchObject({
      kind: 'refuse',
      code: X402_ERROR_CODES.DUPLICATE_NONCE,
    });
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
  });

  it('does not release a batch claim when settlement transport outcome is unknown', async () => {
    const { gate, x402, cancel, settlePayment } = batchFixture();
    await gate.open({ taskId: 't-batch-indeterminate', message: message() });
    const accepted = (await x402.store.get('t-batch-indeterminate'))!.accepts[0]!;
    const opened = await gate.open({
      taskId: 't-batch-indeterminate',
      message: submitted(batchPayload('voucher', accepted)),
    });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');
    settlePayment.mockRejectedValueOnce(new Error('connection lost after commit'));

    await expect(
      gate.settle({
        taskId: 't-batch-indeterminate',
        obligation: opened.obligation,
        usage: { kind: 'total', totalTokens: 100 },
      }),
    ).resolves.toEqual({
      kind: 'failed',
      code: X402_ERROR_CODES.SETTLEMENT_FAILED,
      reason: 'Payment settlement outcome is unavailable.',
    });
    expect(cancel).not.toHaveBeenCalled();
    await expect(gate.offerStore.getClaimStatus?.('t-batch-indeterminate')).resolves.toBe(
      'claimed',
    );
  });

  it('does not abort a late batch failure after another attempt completed', async () => {
    const { gate, x402, cancel } = batchFixture({ settleSuccess: false });
    await gate.open({ taskId: 't-batch-late-failure', message: message() });
    const accepted = (await x402.store.get('t-batch-late-failure'))!.accepts[0]!;
    const opened = await gate.open({
      taskId: 't-batch-late-failure',
      message: submitted(batchPayload('voucher', accepted)),
    });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');
    const now = new Date();
    await x402.store.updateIfStatus('t-batch-late-failure', ['verified'], {
      status: 'completed',
      receipt: {
        transaction: '0xconcurrent',
        network: BATCH.network,
        settledAt: now,
      },
    });

    await expect(
      gate.settle({
        taskId: 't-batch-late-failure',
        obligation: opened.obligation,
        usage: { kind: 'total', totalTokens: 100 },
      }),
    ).resolves.toMatchObject({ kind: 'failed' });
    expect(cancel).not.toHaveBeenCalled();
    await expect(x402.store.get('t-batch-late-failure')).resolves.toMatchObject({
      status: 'completed',
      receipt: { transaction: '0xconcurrent' },
    });
  });

  it('keeps a batch claim when settlement evidence cannot be persisted', async () => {
    const { gate, x402, cancel, resourceServer } = batchFixture();
    await gate.open({ taskId: 't-batch-persistence-error', message: message() });
    const accepted = (await x402.store.get('t-batch-persistence-error'))!.accepts[0]!;
    const opened = await gate.open({
      taskId: 't-batch-persistence-error',
      message: submitted(batchPayload('voucher', accepted)),
    });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');
    vi.spyOn(x402, 'settle').mockRejectedValueOnce(
      new Error('lifecycle write failed after settlement'),
    );

    await expect(
      gate.settle({
        taskId: 't-batch-persistence-error',
        obligation: opened.obligation,
        usage: { kind: 'total', totalTokens: 100 },
      }),
    ).resolves.toEqual({
      kind: 'failed',
      code: X402_ERROR_CODES.SETTLEMENT_FAILED,
      reason: 'Payment settlement failed.',
    });
    expect(cancel).not.toHaveBeenCalled();
    await expect(
      gate.offerStore.getClaimStatus?.('t-batch-persistence-error'),
    ).resolves.toBe('claimed');

    await expect(
      gate.open({
        taskId: 't-batch-persistence-error',
        message: submitted(batchPayload('voucher', accepted)),
      }),
    ).resolves.toMatchObject({
      kind: 'refuse',
      code: X402_ERROR_CODES.DUPLICATE_NONCE,
    });
    expect(resourceServer.verifyPayment).toHaveBeenCalledTimes(1);
  });

  it('retains completed lifecycle state and refuses a settled replay before verify', async () => {
    const { gate, facilitator, x402 } = fixture({ accepts: [EXACT] }, 'after-work');
    await gate.open({ taskId: 't-completed-replay', message: message() });
    const opened = await gate.open({
      taskId: 't-completed-replay',
      message: submitted(exactPayload()),
    });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');
    await gate.settle({ taskId: 't-completed-replay', obligation: opened.obligation });

    await expect(x402.store.get('t-completed-replay')).resolves.toMatchObject({
      status: 'completed',
    });
    await expect(
      gate.open({ taskId: 't-completed-replay', message: submitted(exactPayload()) }),
    ).resolves.toMatchObject({
      kind: 'refuse',
      code: X402_ERROR_CODES.DUPLICATE_NONCE,
    });
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
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
    await expect(x402.store.get('t-cleanup-error')).resolves.toMatchObject({
      status: 'completed',
    });
  });

  it('reports a shared store that cannot delete merchant terms separately', async () => {
    const onError = vi.fn();
    const { facilitator } = fixture({ accepts: [EXACT] }, 'after-work');
    const store = new SharedStoreWithoutDeleteOffer();
    const x402 = new X402Context({ facilitator, store, x402Version: 2 });
    const gate = new MerchantGate({
      x402,
      offerStore: store,
      pricing: async () => ({ accepts: [EXACT] }),
      exactTiming: 'after-work',
      deliveryTiming: 'after-settlement',
      onError,
    });
    await gate.open({ taskId: 't-shared-store-cleanup', message: message() });
    const opened = await gate.open({
      taskId: 't-shared-store-cleanup',
      message: submitted(exactPayload()),
    });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');

    await expect(
      gate.settle({ taskId: 't-shared-store-cleanup', obligation: opened.obligation }),
    ).resolves.toMatchObject({ kind: 'settled' });
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('must implement deleteOffer') }),
      { operation: 'cleanup', taskId: 't-shared-store-cleanup' },
    );
    await expect(store.getOffer('t-shared-store-cleanup')).resolves.toBeDefined();
    await expect(store.get('t-shared-store-cleanup')).resolves.toMatchObject({
      status: 'completed',
    });
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

  it('cancels a batch reservation and permits the voucher on a fresh task', async () => {
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
      kind: 'refuse',
      code: X402_ERROR_CODES.DUPLICATE_NONCE,
    });
    await gate.open({ taskId: 't-batch-abort-retry', message: message() });
    const retryAccepted = (await x402.store.get('t-batch-abort-retry'))!.accepts[0]!;
    await expect(
      gate.open({
        taskId: 't-batch-abort-retry',
        message: submitted(batchPayload('voucher', retryAccepted)),
      }),
    ).resolves.toMatchObject({
      kind: 'proceed',
      obligation: { scheme: 'batch-settlement' },
    });
    expect(resourceServer.verifyPayment).toHaveBeenCalledTimes(2);
  });

  it('retains a batch claim when reservation cancellation cannot be confirmed', async () => {
    const onError = vi.fn();
    const { gate, x402, cancel, resourceServer } = batchFixture({
      cancelFailure: new Error('cancel timeout'),
      onError,
    });
    await gate.open({ taskId: 't-batch-cancel-failure', message: message() });
    const accepted = (await x402.store.get('t-batch-cancel-failure'))!.accepts[0]!;
    const opened = await gate.open({
      taskId: 't-batch-cancel-failure',
      message: submitted(batchPayload('voucher', accepted)),
    });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');

    await expect(
      gate.abort({
        taskId: 't-batch-cancel-failure',
        obligation: opened.obligation,
        reason: 'handler_threw',
      }),
    ).resolves.toMatchObject({ kind: 'failed' });
    expect(cancel).toHaveBeenCalledOnce();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'cancel timeout' }), {
      operation: 'abort',
      taskId: 't-batch-cancel-failure',
    });
    await expect(gate.offerStore.getClaimStatus?.('t-batch-cancel-failure')).resolves.toBe(
      'claimed',
    );
    await expect(
      gate.open({
        taskId: 't-batch-cancel-failure',
        message: submitted(batchPayload('voucher', accepted)),
      }),
    ).resolves.toMatchObject({ kind: 'refuse', code: X402_ERROR_CODES.DUPLICATE_NONCE });
    expect(resourceServer.verifyPayment).toHaveBeenCalledOnce();
  });

  it('cancels and releases a verified batch claim when delivery audit initialization fails', async () => {
    const { gate, x402, cancel, resourceServer } = batchFixture();
    await gate.open({ taskId: 't-batch-audit-init-failure', message: message() });
    const accepted = (await x402.store.get('t-batch-audit-init-failure'))!.accepts[0]!;
    vi.spyOn(x402.store, 'updateMerchantDeliveryIfStatus').mockResolvedValueOnce(undefined);

    await expect(
      gate.open({
        taskId: 't-batch-audit-init-failure',
        message: submitted(batchPayload('voucher', accepted)),
      }),
    ).resolves.toMatchObject({ kind: 'refuse' });
    expect(cancel).toHaveBeenCalledWith({ reason: 'after_verify_aborted' });

    await expect(
      gate.open({
        taskId: 't-batch-audit-init-failure',
        message: submitted(batchPayload('voucher', accepted)),
      }),
    ).resolves.toMatchObject({
      kind: 'proceed',
      obligation: { scheme: 'batch-settlement' },
    });
    expect(resourceServer.verifyPayment).toHaveBeenCalledTimes(2);
  });

  it('retains a verified batch claim when audit compensation cannot cancel it', async () => {
    const { gate, x402, cancel, resourceServer } = batchFixture({
      cancelFailure: new Error('cancel timeout'),
    });
    await gate.open({ taskId: 't-batch-audit-cancel-failure', message: message() });
    const accepted = (await x402.store.get('t-batch-audit-cancel-failure'))!.accepts[0]!;
    vi.spyOn(x402.store, 'updateMerchantDeliveryIfStatus').mockResolvedValueOnce(undefined);

    await expect(
      gate.open({
        taskId: 't-batch-audit-cancel-failure',
        message: submitted(batchPayload('voucher', accepted)),
      }),
    ).resolves.toMatchObject({ kind: 'refuse' });
    expect(cancel).toHaveBeenCalledOnce();
    await expect(
      gate.offerStore.getClaimStatus?.('t-batch-audit-cancel-failure'),
    ).resolves.toBe('claimed');
    await expect(
      gate.open({
        taskId: 't-batch-audit-cancel-failure',
        message: submitted(batchPayload('voucher', accepted)),
      }),
    ).resolves.toMatchObject({ kind: 'refuse', code: X402_ERROR_CODES.DUPLICATE_NONCE });
    expect(resourceServer.verifyPayment).toHaveBeenCalledOnce();
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
    ).resolves.toMatchObject({ kind: 'refuse', code: X402_ERROR_CODES.DUPLICATE_NONCE });
    await gate.open({ taskId: 't-batch-unpriced-retry', message: message() });
    const retryAccepted = (await x402.store.get('t-batch-unpriced-retry'))!.accepts[0]!;
    await expect(
      gate.open({
        taskId: 't-batch-unpriced-retry',
        message: submitted(batchPayload('voucher', retryAccepted)),
      }),
    ).resolves.toMatchObject({ kind: 'proceed' });
  });

  it('linearizes unpriced batch cancellation against publication authorization', async () => {
    let releaseMetadata!: () => void;
    let metadataStarted!: () => void;
    const metadataBlocked = new Promise<void>((resolve) => {
      releaseMetadata = resolve;
    });
    const metadataObserved = new Promise<void>((resolve) => {
      metadataStarted = resolve;
    });
    const { gate, x402, cancel } = batchFixture({
      pricing: { ...BATCH, unreportedUsage: 'refuse' },
      deliveryTiming: 'after-verification',
      deliveryMetadata: async () => {
        metadataStarted();
        await metadataBlocked;
        return {};
      },
    });
    await gate.open({ taskId: 't-batch-unpriced-race', message: message() });
    const accepted = (await x402.store.get('t-batch-unpriced-race'))!.accepts[0]!;
    const opened = await gate.open({
      taskId: 't-batch-unpriced-race',
      message: submitted(batchPayload('voucher', accepted)),
    });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');

    const delivery = gate.authorizeDelivery({ taskId: 't-batch-unpriced-race' });
    await metadataObserved;
    await expect(
      gate.settle({
        taskId: 't-batch-unpriced-race',
        obligation: opened.obligation,
        usage: { kind: 'unreported' },
      }),
    ).resolves.toMatchObject({ kind: 'failed' });
    releaseMetadata();

    await expect(delivery).resolves.toEqual({
      kind: 'blocked',
      reason: 'payment-state-unavailable',
    });
    expect(cancel).toHaveBeenCalledWith({ reason: 'handler_failed' });
    const lifecycle = await x402.store.get('t-batch-unpriced-race');
    expect(lifecycle?.merchantDelivery?.publicationClosedAt).toEqual(expect.any(Date));
    expect(lifecycle?.merchantDelivery?.publicationStartedAt).toBeUndefined();
  });

  it('retains a batch claim when settlement fails after provisional delivery', async () => {
    const { gate, x402, cancel, resourceServer } = batchFixture({
      settleSuccess: false,
      deliveryTiming: 'after-verification',
    });
    await gate.open({ taskId: 't-batch-delivered-failure', message: message() });
    const accepted = (await x402.store.get('t-batch-delivered-failure'))!.accepts[0]!;
    const opened = await gate.open({
      taskId: 't-batch-delivered-failure',
      message: submitted(batchPayload('voucher', accepted)),
    });
    if (opened.kind !== 'proceed' || !opened.obligation) throw new Error('missing obligation');
    await gate.authorizeDelivery({ taskId: 't-batch-delivered-failure' });

    await expect(
      gate.settle({
        taskId: 't-batch-delivered-failure',
        obligation: opened.obligation,
        usage: { kind: 'total', totalTokens: 1_500 },
      }),
    ).resolves.toMatchObject({ kind: 'failed' });
    expect(cancel).not.toHaveBeenCalled();
    await expect(x402.store.get('t-batch-delivered-failure')).resolves.toMatchObject({
      status: 'failed',
      merchantDelivery: {
        publicationStartedAt: expect.any(Date),
        workCompletedAt: expect.any(Date),
        settlementFailedAt: expect.any(Date),
      },
    });
    await expect(
      gate.open({
        taskId: 't-batch-delivered-failure',
        message: submitted(batchPayload('voucher', accepted)),
      }),
    ).resolves.toMatchObject({
      kind: 'refuse',
      code: X402_ERROR_CODES.DUPLICATE_NONCE,
    });
    expect(resourceServer.verifyPayment).toHaveBeenCalledOnce();
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

  it('keeps an indeterminate refund settlement claimed for reconciliation', async () => {
    const { gate, x402, cancel, settlePayment } = batchFixture({ skipHandler: true });
    settlePayment.mockRejectedValueOnce(new Error('connection lost after refund submission'));
    await gate.open({ taskId: 't-batch-refund-indeterminate', message: message() });
    const accepted = (await x402.store.get('t-batch-refund-indeterminate'))!.accepts[0]!;

    await expect(
      gate.open({
        taskId: 't-batch-refund-indeterminate',
        message: submitted(batchPayload('refund', accepted)),
      }),
    ).resolves.toMatchObject({
      kind: 'refuse',
      reason: 'Payment settlement outcome is unavailable.',
    });
    expect(cancel).not.toHaveBeenCalled();
    await expect(x402.store.get('t-batch-refund-indeterminate')).resolves.toMatchObject({
      status: 'failed',
      failure: { point: 'settle', indeterminate: true },
    });
    await expect(
      gate.offerStore.getClaimStatus?.('t-batch-refund-indeterminate'),
    ).resolves.toBe('claimed');
  });

  it('fails closed before publishing batch terms without a registered resource server', async () => {
    const onError = vi.fn();
    const gate = new MerchantGate({
      x402: new X402Context({ x402Version: 2 }),
      pricing: async () => ({ accepts: [BATCH] }),
      exactTiming: 'after-work',
      deliveryTiming: 'after-settlement',
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
