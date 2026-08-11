import {
  X402_ERROR_CODES,
  X402_METADATA_KEYS,
  mapVerifyFailureToCode,
  type X402ErrorCode,
} from '../constants.js';
import type { BaseX402Context, X402ValidClassification } from '../context.js';
import { buildX402PaymentCompletedMetadata } from '../payment.js';
import { sameNetwork } from '../networks.js';
import {
  requirementNetwork,
  requirementPayTo,
  requirementScheme,
} from '../versions.js';
import type { X402SettleResponse } from '../types.js';
import { meterMerchantUsage, offerAccepts, validateMerchantOffer } from './pricing.js';
import {
  InMemoryMerchantOfferStore,
  type MerchantOfferStore,
} from './offer-store.js';
import type {
  MerchantGateOpenInput,
  MerchantGateOpenOutcome,
  MerchantGateSettleInput,
  MerchantGateSettleOutcome,
  MerchantExactTiming,
  MerchantExactPricing,
  MerchantOffer,
  MerchantPricing,
  MerchantPricingResolver,
  MerchantSettledCharge,
  MerchantUptoPricing,
} from './types.js';

export interface MerchantGateOptions {
  x402: BaseX402Context;
  pricing: MerchantPricingResolver;
  offerStore?: MerchantOfferStore;
  /** Required: before/after work intentionally allocate failure risk differently. */
  exactTiming: MerchantExactTiming;
  /** Receives infrastructure errors that are intentionally hidden from payer-facing outcomes. */
  onError?: (error: unknown, context: MerchantGateErrorContext) => void | Promise<void>;
}

export interface MerchantGateErrorContext {
  operation: 'open' | 'settle' | 'cleanup';
  taskId: string;
}

const DEFAULT_OFFER_TTL_SECONDS = 600;
const X402_ERROR_CODE_VALUES: ReadonlySet<string> = new Set(Object.values(X402_ERROR_CODES));

function eventErrorCode(metadata: Record<string, unknown> | undefined): X402ErrorCode | undefined {
  const code = metadata?.[X402_METADATA_KEYS.ERROR];
  return typeof code === 'string' && X402_ERROR_CODE_VALUES.has(code)
    ? (code as X402ErrorCode)
    : undefined;
}

function sameIdentifier(a: string, b: string): boolean {
  return a.startsWith('0x') && b.startsWith('0x')
    ? a.toLowerCase() === b.toLowerCase()
    : a === b;
}

function pricingAmount(pricing: MerchantPricing): string {
  return pricing.scheme === 'upto' ? pricing.maxAmount : pricing.amount;
}

function selectPricing(
  offer: MerchantOffer,
  classified: X402ValidClassification,
): MerchantPricing | undefined {
  const requirement = classified.requirement;
  const matches = offer.accepts.filter((pricing) => {
    const scheme = pricing.scheme ?? 'exact';
    return (
      scheme === requirementScheme(requirement) &&
      sameNetwork(pricing.network, requirementNetwork(requirement)) &&
      sameIdentifier(pricing.asset, requirement.asset) &&
      sameIdentifier(pricing.payTo, requirementPayTo(requirement)) &&
      pricingAmount(pricing) ===
        ('amount' in requirement ? requirement.amount : requirement.maxAmountRequired)
    );
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function refusal(
  code: X402ErrorCode,
  reason: string,
  failureReceipt?: X402SettleResponse,
): MerchantGateOpenOutcome {
  return {
    kind: 'refuse',
    code,
    reason,
    ...(failureReceipt ? { failureReceipt } : {}),
  };
}

function settlementFailure(receipt: X402SettleResponse): MerchantGateSettleOutcome {
  return {
    kind: 'failed',
    code: X402_ERROR_CODES.SETTLEMENT_FAILED,
    reason: receipt.errorReason ?? 'Payment settlement failed.',
    failureReceipt: receipt,
  };
}

export class MerchantGate {
  readonly offerStore: MerchantOfferStore;

  constructor(private readonly options: MerchantGateOptions) {
    this.offerStore = options.offerStore ?? new InMemoryMerchantOfferStore();
  }

  async open(turn: MerchantGateOpenInput): Promise<MerchantGateOpenOutcome> {
    try {
      const classified = await this.options.x402.classify({
        taskId: turn.taskId,
        ...(turn.message === undefined ? {} : { message: turn.message }),
      });
      if (classified.kind === 'no-submission') return await this.requestPayment(turn);
      if (classified.kind !== 'valid') {
        return refusal(classified.code, classified.reason);
      }

      const offer = await this.offerStore.getOffer(turn.taskId);
      if (!offer) {
        return refusal(
          X402_ERROR_CODES.SETTLEMENT_FAILED,
          'The terms this payment was offered under are no longer available.',
        );
      }
      const pricing = selectPricing(offer, classified);
      if (!pricing) {
        return refusal(
          X402_ERROR_CODES.SETTLEMENT_FAILED,
          'The frozen terms and the signed payment disagree; start a new task.',
        );
      }

      const verification = await this.options.x402.verify(turn, classified);
      if (!verification.isValid) {
        const reason = verification.invalidReason ?? 'Payment verification failed.';
        return refusal(mapVerifyFailureToCode(reason), reason);
      }

      if (!(await this.offerStore.claim(turn.taskId))) {
        return refusal(
          X402_ERROR_CODES.DUPLICATE_NONCE,
          'This payment has already been submitted for this task.',
        );
      }

      if ((pricing.scheme ?? 'exact') === 'exact' && this.options.exactTiming === 'before-work') {
        const receipt = await this.options.x402.settle(turn, classified);
        if (!receipt.success) {
          await this.cleanup(turn.taskId);
          return refusal(
            X402_ERROR_CODES.SETTLEMENT_FAILED,
            receipt.errorReason ?? 'Payment settlement failed.',
            receipt,
          );
        }
        await this.cleanup(turn.taskId);
        return {
          kind: 'proceed',
          obligation: { kind: 'settled', receipt, pricing: pricing as MerchantExactPricing },
        };
      }

      return { kind: 'proceed', obligation: { kind: 'deferred', classified, pricing } };
    } catch (error) {
      await this.reportError(error, { operation: 'open', taskId: turn.taskId });
      return refusal(X402_ERROR_CODES.SETTLEMENT_FAILED, 'Payment processing is unavailable.');
    }
  }

  async settle(input: MerchantGateSettleInput): Promise<MerchantGateSettleOutcome> {
    try {
      const outcome = await this.settleObligation(input);
      if (outcome.kind === 'settled') await this.cleanup(input.taskId);
      return outcome;
    } catch (error) {
      await this.reportError(error, { operation: 'settle', taskId: input.taskId });
      return {
        kind: 'failed',
        code: X402_ERROR_CODES.SETTLEMENT_FAILED,
        reason: 'Payment settlement failed.',
      };
    }
  }

  private async settleObligation(
    input: MerchantGateSettleInput,
  ): Promise<MerchantGateSettleOutcome> {
    const { obligation } = input;
    if (obligation.kind === 'settled') {
      return this.settledOutcome(obligation.receipt, {
        requestedAtomic: pricingAmount(obligation.pricing),
        amountAtomic: pricingAmount(obligation.pricing),
        basis: 'exact',
      });
    }

    const pricing = obligation.pricing;
    if (pricing.scheme !== 'upto') {
      const receipt = await this.options.x402.settle(
        { taskId: input.taskId },
        obligation.classified,
      );
      if (!receipt.success) return settlementFailure(receipt);
      return this.settledOutcome(receipt, {
        requestedAtomic: pricing.amount,
        amountAtomic: pricing.amount,
        basis: 'exact',
      });
    }

    const charge = this.resolveUptoCharge(pricing, obligation.classified, input.usage);
    if (charge.kind === 'failed') return charge;
    const receipt = await this.options.x402.settle(
      { taskId: input.taskId },
      obligation.classified,
      { amountAtomic: charge.charge.amountAtomic },
    );
    if (!receipt.success) return settlementFailure(receipt);
    return this.settledOutcome(receipt, charge.charge);
  }

  private async requestPayment(
    turn: MerchantGateOpenInput,
  ): Promise<MerchantGateOpenOutcome> {
    const resolvedOffer = await this.options.pricing(turn);
    if (!resolvedOffer) return { kind: 'proceed' };
    const offer =
      resolvedOffer.expiresInSeconds === undefined
        ? { ...resolvedOffer, expiresInSeconds: DEFAULT_OFFER_TTL_SECONDS }
        : resolvedOffer;
    validateMerchantOffer(offer);

    const published = await this.offerStore.publishing(turn.taskId, offer, async (frozenOffer) => {
      let outcome: Extract<MerchantGateOpenOutcome, { kind: 'request-payment' }> | undefined;
      for await (const event of this.options.x402.requestPayment(
        {
          taskId: turn.taskId,
          ...(turn.activatedExtensions
            ? { activatedExtensions: turn.activatedExtensions }
            : {}),
        },
        {
          accepts: offerAccepts(frozenOffer),
          ...(frozenOffer.description ? { description: frozenOffer.description } : {}),
          ...(frozenOffer.previousError ? { previousError: frozenOffer.previousError } : {}),
          ...(frozenOffer.extensions ? { extensions: frozenOffer.extensions } : {}),
          ...(frozenOffer.expiresInSeconds !== undefined
            ? { expiresInSeconds: frozenOffer.expiresInSeconds }
            : {}),
        },
      )) {
        if (event.type === 'error') {
          const code = eventErrorCode(event.metadata);
          return refusal(
            code ?? X402_ERROR_CODES.SETTLEMENT_FAILED,
            code ? event.error.message : 'Payment processing is unavailable.',
          );
        }
        if (event.type === 'request-input') {
          outcome = {
            kind: 'request-payment',
            text: event.message ?? 'Payment is required to use this service.',
            metadata: event.metadata ?? {},
          };
        }
      }
      if (!outcome) throw new Error('X402Context.requestPayment yielded no request-input event.');
      return outcome;
    });
    if (published.kind === 'refuse') await this.cleanup(turn.taskId);
    return published;
  }

  private resolveUptoCharge(
    pricing: MerchantUptoPricing,
    classified: X402ValidClassification,
    usage: MerchantGateSettleInput['usage'],
  ):
    | { kind: 'charge'; charge: MerchantSettledCharge }
    | Extract<MerchantGateSettleOutcome, { kind: 'failed' }> {
    const metered = meterMerchantUsage(pricing, usage);
    if (metered.kind === 'charge') {
      const amountAtomic = this.clampUptoCharge(pricing, classified, metered.amountAtomic);
      return {
        kind: 'charge',
        charge: {
          requestedAtomic: amountAtomic,
          amountAtomic,
          basis: metered.basis,
        },
      };
    }
    if (pricing.unreportedUsage === 'refuse') {
      return {
        kind: 'failed',
        code: X402_ERROR_CODES.SETTLEMENT_FAILED,
        reason: 'Usage was not reported in a shape that can be priced safely.',
      };
    }
    if (pricing.unreportedUsage === 'ceiling') {
      const amountAtomic = this.clampUptoCharge(pricing, classified, pricing.maxAmount);
      return {
        kind: 'charge',
        charge: {
          requestedAtomic: amountAtomic,
          amountAtomic,
          basis: 'unreported-ceiling',
        },
      };
    }
    const amountAtomic = this.clampUptoCharge(
      pricing,
      classified,
      pricing.minAmount ?? '0',
    );
    return {
      kind: 'charge',
      charge: {
        requestedAtomic: amountAtomic,
        amountAtomic,
        basis: 'unreported-floor',
      },
    };
  }

  private clampUptoCharge(
    pricing: MerchantUptoPricing,
    classified: X402ValidClassification,
    amountAtomic: string,
  ): string {
    const bounds = [BigInt(amountAtomic), BigInt(pricing.maxAmount)];
    const signedCap = classified.submission.permit2Authorization?.permitted.amount;
    if (signedCap !== undefined && /^\d+$/.test(signedCap)) bounds.push(BigInt(signedCap));
    return bounds.reduce((a, b) => (a < b ? a : b)).toString();
  }

  private settledOutcome(
    receipt: X402SettleResponse,
    charge: MerchantSettledCharge,
  ): MerchantGateSettleOutcome {
    const confirmedCharge =
      receipt.amount !== undefined && /^\d+$/.test(receipt.amount)
        ? { ...charge, amountAtomic: receipt.amount }
        : charge;
    return {
      kind: 'settled',
      receipt,
      receiptMetadata: buildX402PaymentCompletedMetadata({ receipt }),
      charge: confirmedCharge,
    };
  }

  private async cleanup(taskId: string): Promise<void> {
    for (const operation of [
      () => this.offerStore.delete(taskId),
      () => this.options.x402.clearOffering({ taskId }),
    ]) {
      try {
        await operation();
      } catch (error) {
        await this.reportError(error, { operation: 'cleanup', taskId });
      }
    }
  }

  private async reportError(error: unknown, context: MerchantGateErrorContext): Promise<void> {
    try {
      await this.options.onError?.(error, context);
    } catch {
      // Error reporting must not change payment behavior or expose infrastructure details.
    }
  }
}
