import { describe, expect, it } from 'vitest';
import {
  merchantPricingToAccept,
  meterMerchantUsage,
  validateMerchantOffer,
  type MerchantUptoPricing,
} from '../x402/index.js';

const BASE_UPTO: MerchantUptoPricing = {
  scheme: 'upto',
  network: 'eip155:84532',
  maxAmount: '1000000',
  minAmount: '1',
  asset: '0xasset',
  payTo: '0xmerchant',
  description: 'Metered work',
  resource: 'https://example.com/work',
  rates: { totalPerThousand: '10' },
  unreportedUsage: 'ceiling',
};

describe('x402 merchant pricing', () => {
  it('prices total-token usage with ceiling division', () => {
    expect(meterMerchantUsage(BASE_UPTO, { kind: 'total', totalTokens: 1001 })).toEqual({
      kind: 'charge',
      amountAtomic: '11',
      basis: 'metered',
    });
  });

  it('prices detailed usage with a separate cached-input rate using BigInt', () => {
    const pricing: MerchantUptoPricing = {
      ...BASE_UPTO,
      rates: {
        inputPerMillion: '2',
        outputPerMillion: '4',
        cachedInputPerMillion: '1',
      },
    };
    expect(
      meterMerchantUsage(pricing, {
        kind: 'detailed',
        inputTokens: 1_000_000,
        cachedInputTokens: 500_000,
        outputTokens: 500_000,
      }),
    ).toEqual({ kind: 'charge', amountAtomic: '4', basis: 'metered' });
  });

  it('applies the floor only to non-zero work', () => {
    const pricing = { ...BASE_UPTO, minAmount: '100' };
    expect(meterMerchantUsage(pricing, { kind: 'total', totalTokens: 1 })).toEqual({
      kind: 'charge',
      amountAtomic: '100',
      basis: 'floor',
    });
    expect(meterMerchantUsage(pricing, { kind: 'total', totalTokens: 0 })).toEqual({
      kind: 'charge',
      amountAtomic: '0',
      basis: 'zero',
    });
  });

  it('does not infer whether a host zero is trusted', () => {
    expect(meterMerchantUsage(BASE_UPTO, { kind: 'unreported' })).toEqual({
      kind: 'unpriceable',
    });
    expect(meterMerchantUsage(BASE_UPTO, undefined)).toEqual({ kind: 'unpriceable' });
  });

  it('routes a total-only reading against split rates to unpriceable', () => {
    const pricing: MerchantUptoPricing = {
      ...BASE_UPTO,
      rates: { inputPerMillion: '2', outputPerMillion: '4' },
    };
    expect(meterMerchantUsage(pricing, { kind: 'total', totalTokens: 10 })).toEqual({
      kind: 'unpriceable',
    });
  });

  it('rejects incoherent usage instead of inventing a charge', () => {
    const pricing: MerchantUptoPricing = {
      ...BASE_UPTO,
      rates: { inputPerMillion: '2', outputPerMillion: '4' },
    };
    expect(
      meterMerchantUsage(pricing, {
        kind: 'detailed',
        inputTokens: 2,
        cachedInputTokens: 3,
        outputTokens: 1,
      }),
    ).toEqual({ kind: 'unpriceable' });
  });

  it('converts maxAmount to the x402 offered amount', () => {
    expect(merchantPricingToAccept(BASE_UPTO)).toMatchObject({
      scheme: 'upto',
      amount: '1000000',
    });
  });

  it('fails invalid merchant pricing before it is published', () => {
    expect(() =>
      validateMerchantOffer({
        accepts: [{ ...BASE_UPTO, minAmount: '1000001' }],
      }),
    ).toThrow(/minAmount must not exceed maxAmount/);
  });

  it('rejects duplicate payment identities before publishing', () => {
    expect(() =>
      validateMerchantOffer({
        accepts: [
          BASE_UPTO,
          {
            ...BASE_UPTO,
            network: 'base-sepolia',
            asset: `0x${BASE_UPTO.asset.slice(2).toUpperCase()}`,
            payTo: `0x${BASE_UPTO.payTo.slice(2).toUpperCase()}`,
            description: 'Duplicate with different display text',
          },
        ],
      }),
    ).toThrow(/duplicate payment identities/);
  });
});
