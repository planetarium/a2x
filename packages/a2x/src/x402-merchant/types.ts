import type { BaseX402Context, X402ValidClassification } from '../x402/context.js';
import type { X402ErrorCode } from '../x402/constants.js';
import type { X402Accept, X402SettleResponse } from '../x402/types.js';

export type MerchantExactTiming = 'before-work' | 'after-work';

export type MerchantUnreportedUsagePolicy = 'ceiling' | 'floor' | 'refuse';

export interface MerchantDetailedRates {
  inputPerMillion: string;
  outputPerMillion: string;
  cachedInputPerMillion?: string;
}

export interface MerchantTotalRate {
  totalPerThousand: string;
}

export type MerchantUsageRates = MerchantDetailedRates | MerchantTotalRate;

export interface MerchantExactPricing extends Omit<X402Accept, 'scheme'> {
  scheme?: 'exact';
}

export interface MerchantUptoPricing extends Omit<X402Accept, 'scheme' | 'amount'> {
  scheme: 'upto';
  /** Maximum the payer authorizes, in the asset's smallest unit. */
  maxAmount: string;
  /** Floor for non-zero metered work. Never applied to trusted reported zero. */
  minAmount?: string;
  rates: MerchantUsageRates;
  /** Required because hosts intentionally choose different risk allocations. */
  unreportedUsage: MerchantUnreportedUsagePolicy;
}

export type MerchantPricing = MerchantExactPricing | MerchantUptoPricing;

/**
 * Terms published together on turn 1. The sidecar freezes this complete value,
 * so turn 2 never re-runs the pricing callback against live configuration.
 */
export interface MerchantOffer {
  accepts: readonly MerchantPricing[];
  description?: string;
  previousError?: string;
  extensions?: Record<string, unknown>;
  expiresInSeconds?: number;
}

export type MerchantTurnRef = Parameters<BaseX402Context['classify']>[0];

export interface MerchantGateOpenInput extends MerchantTurnRef {
  taskId: string;
  contextId?: string;
  activatedExtensions?: readonly string[];
}

export type MerchantPricingResolver = (
  turn: MerchantGateOpenInput,
) => MerchantOffer | null | Promise<MerchantOffer | null>;

export type MeterableUsage =
  | {
      kind: 'detailed';
      inputTokens: number;
      outputTokens: number;
      /** Breakdown of inputTokens, not an additional count. */
      cachedInputTokens?: number;
    }
  | { kind: 'total'; totalTokens: number }
  | { kind: 'unreported' };

export type MeteredCharge =
  | {
      kind: 'charge';
      amountAtomic: string;
      basis: 'metered' | 'floor' | 'zero';
    }
  | { kind: 'unpriceable' };

export interface MerchantDeferredObligation {
  kind: 'deferred';
  classified: X402ValidClassification;
  pricing: MerchantPricing;
}

export interface MerchantSettledObligation {
  kind: 'settled';
  receipt: X402SettleResponse;
  pricing: MerchantExactPricing;
}

export type MerchantObligation = MerchantDeferredObligation | MerchantSettledObligation;

export type MerchantGateOpenOutcome =
  | {
      kind: 'request-payment';
      text: string;
      metadata: Record<string, unknown>;
    }
  | {
      kind: 'refuse';
      code: X402ErrorCode;
      reason: string;
      failureReceipt?: X402SettleResponse;
    }
  | { kind: 'proceed'; obligation?: MerchantObligation };

export interface MerchantGateSettleInput {
  taskId: string;
  obligation: MerchantObligation;
  usage?: MeterableUsage;
}

export interface MerchantSettledCharge {
  amountAtomic: string;
  basis: 'exact' | 'metered' | 'floor' | 'zero' | 'unreported-ceiling' | 'unreported-floor';
}

export type MerchantGateSettleOutcome =
  | {
      kind: 'settled';
      receiptMetadata: Record<string, unknown>;
      receipt: X402SettleResponse;
      charge?: MerchantSettledCharge;
    }
  | {
      kind: 'failed';
      code: X402ErrorCode;
      reason: string;
      failureReceipt?: X402SettleResponse;
    };
