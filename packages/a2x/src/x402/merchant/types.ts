import type { BaseX402Context, X402ValidClassification } from '../context.js';
import type { X402ErrorCode } from '../constants.js';
import type {
  X402Accept,
  X402PaymentCancellation,
  X402SettleResponse,
  X402SkipHandlerDirective,
  X402VerifiedPaymentCancellationReason,
} from '../types.js';
import type { Message } from '../../types/common.js';

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

export interface MerchantMeteredPricing {
  /** Maximum the payer authorizes, in the asset's smallest unit. */
  maxAmount: string;
  /** Floor for non-zero metered work. Never applied to trusted reported zero. */
  minAmount?: string;
  rates: MerchantUsageRates;
  /** Required because hosts intentionally choose different risk allocations. */
  unreportedUsage: MerchantUnreportedUsagePolicy;
}

export interface MerchantUptoPricing
  extends Omit<X402Accept, 'scheme' | 'amount'>,
    MerchantMeteredPricing {
  scheme: 'upto';
}

export interface MerchantBatchSettlementPricing
  extends Omit<X402Accept, 'scheme' | 'amount'>,
    MerchantMeteredPricing {
  scheme: 'batch-settlement';
}

export type MerchantPricing =
  | MerchantExactPricing
  | MerchantUptoPricing
  | MerchantBatchSettlementPricing;

/**
 * Terms published together on turn 1. The offer store freezes this complete value,
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

export interface MerchantGateOpenInput extends Omit<MerchantTurnRef, 'taskId' | 'message'> {
  taskId: string;
  /** An absent message is classified as a first-turn, unpaid request. */
  message?: Message | undefined;
  contextId?: string | undefined;
  activatedExtensions?: readonly string[] | undefined;
}

export type MerchantPricingResolver = (
  turn: MerchantGateOpenInput,
) => MerchantOffer | null | Promise<MerchantOffer | null>;

export type MerchantMeterableUsage =
  | {
      kind: 'detailed';
      inputTokens: number;
      outputTokens: number;
      /** Breakdown of inputTokens, not an additional count. */
      cachedInputTokens?: number;
    }
  | { kind: 'total'; totalTokens: number }
  | { kind: 'unreported' };

export type MerchantMeteredCharge =
  | {
      kind: 'charge';
      amountAtomic: string;
      basis: 'metered' | 'floor' | 'zero';
    }
  | { kind: 'unpriceable' };

export type MerchantDeferredObligation =
  | {
      kind: 'deferred';
      scheme: 'exact';
      classified: X402ValidClassification;
      pricing: MerchantExactPricing;
    }
  | {
      kind: 'deferred';
      scheme: 'upto';
      classified: X402ValidClassification;
      pricing: MerchantUptoPricing;
    }
  | {
      kind: 'deferred';
      scheme: 'batch-settlement';
      classified: X402ValidClassification;
      pricing: MerchantBatchSettlementPricing;
      cancellation: X402PaymentCancellation;
    };

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
  | {
      kind: 'handled';
      operation: 'batch-refund';
      response?: X402SkipHandlerDirective;
      receiptMetadata: Record<string, unknown>;
      receipt: X402SettleResponse;
    }
  | { kind: 'proceed'; obligation?: MerchantObligation };

export interface MerchantGateSettleInput {
  taskId: string;
  obligation: MerchantObligation;
  usage?: MerchantMeterableUsage;
}

export interface MerchantGateAbortInput {
  taskId: string;
  obligation: MerchantObligation;
  reason: X402VerifiedPaymentCancellationReason;
  error?: unknown;
  responseStatus?: number;
}

export interface MerchantSettledCharge {
  /** Amount requested from the facilitator, before receipt reconciliation. */
  requestedAtomic: string;
  /** Facilitator-reported amount when present, otherwise requestedAtomic. */
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
