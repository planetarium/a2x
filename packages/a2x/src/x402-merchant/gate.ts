import {
  X402_ERROR_CODES,
  mapVerifyFailureToCode,
  type X402ErrorCode,
} from '../x402/constants.js';
import type { BaseX402Context, X402ValidClassification } from '../x402/context.js';
import { buildX402PaymentCompletedMetadata } from '../x402/payment.js';
import { sameNetwork } from '../x402/networks.js';
import {
  requirementNetwork,
  requirementPayTo,
  requirementScheme,
} from '../x402/versions.js';
import type { X402SettleResponse } from '../x402/types.js';
import { meterUsage, offerAccepts, validateMerchantOffer } from './pricing.js';
import {
  InMemoryMerchantOfferingSidecar,
  type MerchantOfferingSidecar,
} from './sidecar.js';
import type {
  MerchantGateOpenInput,
  MerchantGateOpenOutcome,
  MerchantGateSettleInput,
  MerchantGateSettleOutcome,
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
  sidecar?: MerchantOfferingSidecar;
  /** Required: before/after work intentionally allocate failure risk differently. */
  exactTiming: 'before-work' | 'after-work';
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
  readonly sidecar: MerchantOfferingSidecar;

  constructor(private readonly options: MerchantGateOptions) {
    this.sidecar = options.sidecar ?? new InMemoryMerchantOfferingSidecar();
  }

  async open(turn: MerchantGateOpenInput): Promise<MerchantGateOpenOutcome> {
    try {
      const classified = await this.options.x402.classify(turn);
      if (classified.kind === 'no-submission') return await this.requestPayment(turn);
      if (classified.kind !== 'valid') {
        return refusal(classified.code, classified.reason);
      }

      if (!(await this.sidecar.claim(turn.taskId))) {
        return refusal(
          X402_ERROR_CODES.DUPLICATE_NONCE,
          'This payment has already been submitted for this task.',
        );
      }
      const offer = await this.sidecar.getOffer(turn.taskId);
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

      if ((pricing.scheme ?? 'exact') === 'exact' && this.options.exactTiming === 'before-work') {
        const receipt = await this.options.x402.settle(turn, classified);
        if (!receipt.success) {
          return refusal(
            X402_ERROR_CODES.SETTLEMENT_FAILED,
            receipt.errorReason ?? 'Payment settlement failed.',
            receipt,
          );
        }
        return {
          kind: 'proceed',
          obligation: { kind: 'settled', receipt, pricing: pricing as MerchantExactPricing },
        };
      }

      return { kind: 'proceed', obligation: { kind: 'deferred', classified, pricing } };
    } catch (error) {
      return refusal(
        X402_ERROR_CODES.SETTLEMENT_FAILED,
        error instanceof Error ? error.message : 'Payment processing is unavailable.',
      );
    }
  }

  async settle(input: MerchantGateSettleInput): Promise<MerchantGateSettleOutcome> {
    try {
      return await this.settleObligation(input);
    } catch (error) {
      return {
        kind: 'failed',
        code: X402_ERROR_CODES.SETTLEMENT_FAILED,
        reason: error instanceof Error ? error.message : 'Payment settlement failed.',
      };
    }
  }

  private async settleObligation(
    input: MerchantGateSettleInput,
  ): Promise<MerchantGateSettleOutcome> {
    const { obligation } = input;
    if (obligation.kind === 'settled') {
      return this.settledOutcome(obligation.receipt, {
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
    const offer = await this.options.pricing(turn);
    if (!offer) return { kind: 'proceed' };
    validateMerchantOffer(offer);

    return this.sidecar.publishing(turn.taskId, offer, async (frozenOffer) => {
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
  }

  private resolveUptoCharge(
    pricing: MerchantUptoPricing,
    classified: X402ValidClassification,
    usage: MerchantGateSettleInput['usage'],
  ):
    | { kind: 'charge'; charge: MerchantSettledCharge }
    | Extract<MerchantGateSettleOutcome, { kind: 'failed' }> {
    const metered = meterUsage(pricing, usage);
    if (metered.kind === 'charge') {
      return {
        kind: 'charge',
        charge: {
          amountAtomic: this.clampUptoCharge(pricing, classified, metered.amountAtomic),
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
      return {
        kind: 'charge',
        charge: {
          amountAtomic: this.clampUptoCharge(pricing, classified, pricing.maxAmount),
          basis: 'unreported-ceiling',
        },
      };
    }
    return {
      kind: 'charge',
      charge: {
        amountAtomic: this.clampUptoCharge(
          pricing,
          classified,
          pricing.minAmount ?? '0',
        ),
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
}
