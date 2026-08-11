import {
  X402_ERROR_CODES,
  X402_METADATA_KEYS,
  mapVerifyFailureToCode,
  type X402ErrorCode,
} from '../constants.js';
import type { BaseX402Context, X402ValidClassification } from '../context.js';
import { buildX402PaymentCompletedMetadata } from '../payment.js';
import { sameNetwork, toCaip2 } from '../networks.js';
import {
  requirementNetwork,
  requirementPayTo,
  requirementScheme,
} from '../versions.js';
import type {
  X402PaymentCancellation,
  X402SettleResponse,
  X402VerifiedPaymentCancellationReason,
} from '../types.js';
import { meterMerchantUsage, offerAccepts, validateMerchantOffer } from './pricing.js';
import {
  InMemoryMerchantOfferStore,
  type MerchantOfferStore,
} from './offer-store.js';
import type {
  MerchantGateOpenInput,
  MerchantGateOpenOutcome,
  MerchantGateAbortInput,
  MerchantGateSettleInput,
  MerchantGateSettleOutcome,
  MerchantExactTiming,
  MerchantExactPricing,
  MerchantBatchSettlementPricing,
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
  operation: 'open' | 'settle' | 'abort' | 'cleanup';
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
  return pricing.scheme === 'upto' || pricing.scheme === 'batch-settlement'
    ? pricing.maxAmount
    : pricing.amount;
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

      let claimed: boolean;
      try {
        claimed = await this.offerStore.claim(turn.taskId);
      } catch (error) {
        await this.cancelVerification(
          turn.taskId,
          verification.cancellation,
          'after_verify_aborted',
        );
        throw error;
      }
      if (!claimed) {
        await this.cancelVerification(
          turn.taskId,
          verification.cancellation,
          'after_verify_aborted',
        );
        return refusal(
          X402_ERROR_CODES.DUPLICATE_NONCE,
          'This payment has already been submitted for this task.',
        );
      }

      if (verification.skipHandler) {
        if (pricing.scheme !== 'batch-settlement') {
          await this.cancelVerification(
            turn.taskId,
            verification.cancellation,
            'after_verify_aborted',
          );
          await this.offerStore.release(turn.taskId);
          return refusal(
            X402_ERROR_CODES.SETTLEMENT_FAILED,
            'The payment scheme requested an unsupported handler bypass.',
          );
        }
        const receipt = await this.options.x402.settle(turn, classified);
        if (!receipt.success) {
          await this.cancelVerification(
            turn.taskId,
            verification.cancellation,
            'handler_failed',
          );
          await this.offerStore.release(turn.taskId);
          return refusal(
            X402_ERROR_CODES.SETTLEMENT_FAILED,
            receipt.errorReason ?? 'Payment settlement failed.',
            receipt,
          );
        }
        await this.cleanup(turn.taskId, { retainX402Receipt: true });
        return {
          kind: 'handled',
          operation: 'batch-refund',
          response: verification.skipHandler,
          receipt,
          receiptMetadata: buildX402PaymentCompletedMetadata({ receipt }),
        };
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

      switch (pricing.scheme ?? 'exact') {
        case 'exact':
          return {
            kind: 'proceed',
            obligation: {
              kind: 'deferred',
              scheme: 'exact',
              classified,
              pricing: pricing as MerchantExactPricing,
            },
          };
        case 'upto':
          return {
            kind: 'proceed',
            obligation: {
              kind: 'deferred',
              scheme: 'upto',
              classified,
              pricing: pricing as MerchantUptoPricing,
            },
          };
        case 'batch-settlement':
          if (!verification.cancellation) {
            await this.offerStore.release(turn.taskId);
            return refusal(
              X402_ERROR_CODES.SETTLEMENT_FAILED,
              'Batch settlement requires a configured x402 resource server.',
            );
          }
          return {
            kind: 'proceed',
            obligation: {
              kind: 'deferred',
              scheme: 'batch-settlement',
              classified,
              pricing: pricing as MerchantBatchSettlementPricing,
              cancellation: verification.cancellation,
            },
          };
      }
    } catch (error) {
      await this.reportError(error, { operation: 'open', taskId: turn.taskId });
      return refusal(X402_ERROR_CODES.SETTLEMENT_FAILED, 'Payment processing is unavailable.');
    }
  }

  async settle(input: MerchantGateSettleInput): Promise<MerchantGateSettleOutcome> {
    try {
      const outcome = await this.settleObligation(input);
      const isBatch =
        input.obligation.kind === 'deferred' &&
        input.obligation.scheme === 'batch-settlement';
      if (outcome.kind === 'settled') {
        await this.cleanup(input.taskId, { retainX402Receipt: isBatch });
      } else if (isBatch) {
        await this.abort({
          taskId: input.taskId,
          obligation: input.obligation,
          reason: 'handler_failed',
        });
      }
      return outcome;
    } catch (error) {
      if (
        input.obligation.kind === 'deferred' &&
        input.obligation.scheme === 'batch-settlement'
      ) {
        await this.abort({
          taskId: input.taskId,
          obligation: input.obligation,
          reason: 'handler_threw',
          error,
        });
      }
      await this.reportError(error, { operation: 'settle', taskId: input.taskId });
      return {
        kind: 'failed',
        code: X402_ERROR_CODES.SETTLEMENT_FAILED,
        reason: 'Payment settlement failed.',
      };
    }
  }

  /** Release retryable state after verified resource work does not complete. */
  async abort(input: MerchantGateAbortInput): Promise<void> {
    if (input.obligation.kind !== 'deferred' || input.obligation.scheme !== 'batch-settlement') {
      return;
    }
    try {
      await input.obligation.cancellation.cancel({
        reason: input.reason,
        ...(input.error === undefined ? {} : { error: input.error }),
        ...(input.responseStatus === undefined
          ? {}
          : { responseStatus: input.responseStatus }),
      });
    } catch (error) {
      await this.reportError(error, { operation: 'abort', taskId: input.taskId });
    } finally {
      try {
        await this.offerStore.release(input.taskId);
      } catch (error) {
        await this.reportError(error, { operation: 'abort', taskId: input.taskId });
      }
    }
  }

  /** Let an unused held authorization expire without attempting settlement. */
  async lapse(taskId: string): Promise<void> {
    await this.cleanup(taskId);
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

    if (obligation.scheme === 'exact') {
      const receipt = await this.options.x402.settle(
        { taskId: input.taskId },
        obligation.classified,
      );
      if (!receipt.success) return settlementFailure(receipt);
      return this.settledOutcome(receipt, {
        requestedAtomic: obligation.pricing.amount,
        amountAtomic: obligation.pricing.amount,
        basis: 'exact',
      });
    }

    const charge = this.resolveMeteredCharge(
      obligation.pricing,
      obligation.classified,
      input.usage,
    );
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
    const frozenOffer = await this.offerStore.getOffer(turn.taskId);
    const resolvedOffer = frozenOffer ?? (await this.options.pricing(turn));
    if (!resolvedOffer) return { kind: 'proceed' };
    const offer =
      resolvedOffer.expiresInSeconds === undefined
        ? { ...resolvedOffer, expiresInSeconds: DEFAULT_OFFER_TTL_SECONDS }
        : resolvedOffer;
    validateMerchantOffer(offer);
    for (const pricing of offer.accepts) {
      if (
        pricing.scheme === 'batch-settlement' &&
        !this.options.x402.supportsResourceServerScheme(
          toCaip2(pricing.network),
          'batch-settlement',
        )
      ) {
        throw new Error(
          'MerchantGate: batch-settlement requires an x402 resource server with the ' +
            `scheme registered for ${toCaip2(pricing.network)}.`,
        );
      }
    }

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

  private resolveMeteredCharge(
    pricing: MerchantUptoPricing | MerchantBatchSettlementPricing,
    classified: X402ValidClassification,
    usage: MerchantGateSettleInput['usage'],
  ):
    | { kind: 'charge'; charge: MerchantSettledCharge }
    | Extract<MerchantGateSettleOutcome, { kind: 'failed' }> {
    const metered = meterMerchantUsage(pricing, usage);
    if (metered.kind === 'charge') {
      const amountAtomic = this.clampMeteredCharge(pricing, classified, metered.amountAtomic);
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
      const amountAtomic = this.clampMeteredCharge(pricing, classified, pricing.maxAmount);
      return {
        kind: 'charge',
        charge: {
          requestedAtomic: amountAtomic,
          amountAtomic,
          basis: 'unreported-ceiling',
        },
      };
    }
    const amountAtomic = this.clampMeteredCharge(
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

  private clampMeteredCharge(
    pricing: MerchantUptoPricing | MerchantBatchSettlementPricing,
    classified: X402ValidClassification,
    amountAtomic: string,
  ): string {
    const bounds = [BigInt(amountAtomic), BigInt(pricing.maxAmount)];
    if (pricing.scheme === 'upto') {
      const signedCap = classified.submission.permit2Authorization?.permitted.amount;
      if (signedCap !== undefined && /^\d+$/.test(signedCap)) bounds.push(BigInt(signedCap));
    }
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

  private async cleanup(
    taskId: string,
    options: { retainX402Receipt?: boolean } = {},
  ): Promise<void> {
    const operations = [() => this.offerStore.delete(taskId)];
    if (!options.retainX402Receipt) {
      operations.push(() => this.options.x402.clearOffering({ taskId }));
    }
    for (const operation of operations) {
      try {
        await operation();
      } catch (error) {
        await this.reportError(error, { operation: 'cleanup', taskId });
      }
    }
  }

  private async cancelVerification(
    taskId: string,
    cancellation: X402PaymentCancellation | undefined,
    reason: X402VerifiedPaymentCancellationReason,
  ): Promise<void> {
    try {
      await cancellation?.cancel({ reason });
    } catch (error) {
      await this.reportError(error, { operation: 'abort', taskId });
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
