import { sameNetwork } from '../networks.js';
import type { X402Accept } from '../types.js';
import type {
  MerchantDetailedRates,
  MerchantOffer,
  MerchantPricing,
  MerchantTotalRate,
  MerchantUptoPricing,
  MerchantMeterableUsage,
  MerchantMeteredCharge,
} from './types.js';

const DECIMAL_ATOMIC = /^\d+$/;

function atomic(value: string, field: string): bigint {
  if (!DECIMAL_ATOMIC.test(value)) {
    throw new Error(`${field} must be a decimal integer string, got ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

function tokenCount(value: number): bigint | undefined {
  if (!Number.isSafeInteger(value) || value < 0) return undefined;
  return BigInt(value);
}

function isDetailedRates(rates: MerchantUptoPricing['rates']): rates is MerchantDetailedRates {
  return 'inputPerMillion' in rates;
}

function isTotalRate(rates: MerchantUptoPricing['rates']): rates is MerchantTotalRate {
  return 'totalPerThousand' in rates;
}

function sameIdentifier(a: string, b: string): boolean {
  return a.startsWith('0x') && b.startsWith('0x')
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function pricingAmount(pricing: MerchantPricing): string {
  return pricing.scheme === 'upto' ? pricing.maxAmount : pricing.amount;
}

function samePricingIdentity(a: MerchantPricing, b: MerchantPricing): boolean {
  return (
    (a.scheme ?? 'exact') === (b.scheme ?? 'exact') &&
    sameNetwork(a.network, b.network) &&
    sameIdentifier(a.asset, b.asset) &&
    sameIdentifier(a.payTo, b.payTo) &&
    pricingAmount(a) === pricingAmount(b)
  );
}

function applyFloor(metered: bigint, pricing: MerchantUptoPricing): MerchantMeteredCharge {
  const floor = atomic(pricing.minAmount ?? '0', 'minAmount');
  if (metered < floor) {
    return { kind: 'charge', amountAtomic: floor.toString(), basis: 'floor' };
  }
  return { kind: 'charge', amountAtomic: metered.toString(), basis: 'metered' };
}

function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  return numerator === 0n ? 0n : (numerator + denominator - 1n) / denominator;
}

/**
 * Convert trusted, normalized usage into an atomic charge. Host adapters own
 * the meaning of their raw counters: a runtime that uses zero as an
 * "unreported" sentinel must emit `{ kind: 'unreported' }` instead.
 */
export function meterMerchantUsage(
  pricing: MerchantUptoPricing,
  usage: MerchantMeterableUsage | undefined,
): MerchantMeteredCharge {
  if (usage === undefined || usage.kind === 'unreported') return { kind: 'unpriceable' };

  if (usage.kind === 'total') {
    const total = tokenCount(usage.totalTokens);
    if (total === undefined) return { kind: 'unpriceable' };
    if (total === 0n) return { kind: 'charge', amountAtomic: '0', basis: 'zero' };
    if (!isTotalRate(pricing.rates)) return { kind: 'unpriceable' };
    const metered = ceilDiv(
      total * atomic(pricing.rates.totalPerThousand, 'totalPerThousand'),
      1_000n,
    );
    return applyFloor(metered, pricing);
  }

  const input = tokenCount(usage.inputTokens);
  const output = tokenCount(usage.outputTokens);
  const cached = tokenCount(usage.cachedInputTokens ?? 0);
  if (input === undefined || output === undefined || cached === undefined || cached > input) {
    return { kind: 'unpriceable' };
  }
  if (input === 0n && output === 0n) {
    return { kind: 'charge', amountAtomic: '0', basis: 'zero' };
  }

  if (isTotalRate(pricing.rates)) {
    const metered = ceilDiv(
      (input + output) * atomic(pricing.rates.totalPerThousand, 'totalPerThousand'),
      1_000n,
    );
    return applyFloor(metered, pricing);
  }
  if (!isDetailedRates(pricing.rates)) return { kind: 'unpriceable' };

  const cachedRate = atomic(
    pricing.rates.cachedInputPerMillion ?? pricing.rates.inputPerMillion,
    'cachedInputPerMillion',
  );
  const micros =
    (input - cached) * atomic(pricing.rates.inputPerMillion, 'inputPerMillion') +
    cached * cachedRate +
    output * atomic(pricing.rates.outputPerMillion, 'outputPerMillion');
  return applyFloor(ceilDiv(micros, 1_000_000n), pricing);
}

export function merchantPricingToAccept(pricing: MerchantPricing): X402Accept {
  if (pricing.scheme === 'upto') {
    const { maxAmount, minAmount: _minAmount, rates: _rates, unreportedUsage: _policy, ...accept } =
      pricing;
    return { ...accept, scheme: 'upto', amount: maxAmount };
  }
  return { ...pricing, scheme: pricing.scheme ?? 'exact' };
}

export function offerAccepts(offer: MerchantOffer): X402Accept[] {
  return offer.accepts.map(merchantPricingToAccept);
}

/** Fail fast on merchant configuration before publishing terms to a payer. */
export function validateMerchantOffer(offer: MerchantOffer): void {
  if (offer.accepts.length === 0) throw new Error('MerchantOffer.accepts must not be empty.');
  if (
    offer.expiresInSeconds !== undefined &&
    (!Number.isFinite(offer.expiresInSeconds) || offer.expiresInSeconds <= 0)
  ) {
    throw new Error('MerchantOffer.expiresInSeconds must be greater than zero.');
  }
  for (const [index, pricing] of offer.accepts.entries()) {
    if (offer.accepts.slice(0, index).some((candidate) => samePricingIdentity(candidate, pricing))) {
      throw new Error('MerchantOffer.accepts must not contain duplicate payment identities.');
    }
    const ceiling = atomic(
      pricing.scheme === 'upto' ? pricing.maxAmount : pricing.amount,
      pricing.scheme === 'upto' ? 'maxAmount' : 'amount',
    );
    if (ceiling <= 0n) throw new Error('Merchant pricing ceiling must be greater than zero.');
    if (pricing.scheme !== 'upto') continue;
    const floor = atomic(pricing.minAmount ?? '0', 'minAmount');
    if (floor > ceiling) throw new Error('minAmount must not exceed maxAmount.');
    if (isDetailedRates(pricing.rates)) {
      atomic(pricing.rates.inputPerMillion, 'inputPerMillion');
      atomic(pricing.rates.outputPerMillion, 'outputPerMillion');
      if (pricing.rates.cachedInputPerMillion !== undefined) {
        atomic(pricing.rates.cachedInputPerMillion, 'cachedInputPerMillion');
      }
    } else {
      atomic(pricing.rates.totalPerThousand, 'totalPerThousand');
    }
  }
}
