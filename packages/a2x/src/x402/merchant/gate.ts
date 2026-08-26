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
  MerchantGateAbortOutcome,
  MerchantGateAuthorizeDeliveryInput,
  MerchantGateAuthorizeDeliveryOutcome,
  MerchantGateSettleInput,
  MerchantGateSettleOutcome,
  MerchantDeliveryMetadataBuilder,
  MerchantDeliveryTiming,
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
  /** Required: verification and settlement allocate delivery risk differently. */
  deliveryTiming: MerchantDeliveryTiming;
  /** Maps delivery state to metadata. May be retried across phases; keep it side-effect-free. */
  deliveryMetadata?: MerchantDeliveryMetadataBuilder;
  /** Receives infrastructure errors that are intentionally hidden from payer-facing outcomes. */
  onError?: (error: unknown, context: MerchantGateErrorContext) => void | Promise<void>;
}

export interface MerchantGateErrorContext {
  operation: 'open' | 'authorize-delivery' | 'settle' | 'abort' | 'cleanup';
  taskId: string;
}

const DEFAULT_OFFER_TTL_SECONDS = 600;
const MAX_DELIVERY_AUTHORIZATION_ATTEMPTS = 10;
const X402_ERROR_CODE_VALUES: ReadonlySet<string> = new Set(Object.values(X402_ERROR_CODES));

/** Internal signal used by the session manager to settle instead of lapsing. */
export class MerchantDeliveryPublishedError extends Error {
  constructor() {
    super(
      'MerchantGate cannot lapse an authorization after content publication; settle or abort it.',
    );
    this.name = 'MerchantDeliveryPublishedError';
  }
}

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
): Extract<MerchantGateOpenOutcome, { kind: 'refuse' }> {
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
    if (
      options.deliveryTiming !== 'after-settlement' &&
      options.deliveryTiming !== 'after-verification'
    ) {
      throw new Error(
        "MerchantGate.deliveryTiming must be 'after-settlement' or 'after-verification'.",
      );
    }
    this.offerStore = options.offerStore ?? new InMemoryMerchantOfferStore();
  }

  get deliveryTiming(): MerchantDeliveryTiming {
    return this.options.deliveryTiming;
  }

  async open(turn: MerchantGateOpenInput): Promise<MerchantGateOpenOutcome> {
    try {
      const replay = await this.replayRefusal(turn.taskId);
      if (replay) return replay;
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
          const canceled = await this.cancelVerification(
            turn.taskId,
            verification.cancellation,
            'after_verify_aborted',
          );
          if (canceled) await this.offerStore.release(turn.taskId);
          return refusal(
            X402_ERROR_CODES.SETTLEMENT_FAILED,
            'The payment scheme requested an unsupported handler bypass.',
          );
        }
        const receipt = await this.options.x402.settle(turn, classified);
        if (!receipt.success) {
          const lifecycle = await this.options.x402.store.get(turn.taskId);
          if (lifecycle?.failure?.indeterminate === true) {
            await this.reportError(new Error(lifecycle.failure.reason), {
              operation: 'open',
              taskId: turn.taskId,
            });
            return refusal(
              X402_ERROR_CODES.SETTLEMENT_FAILED,
              'Payment settlement outcome is unavailable.',
            );
          }
          const canceled = await this.cancelVerification(
            turn.taskId,
            verification.cancellation,
            'handler_failed',
          );
          if (canceled) await this.offerStore.release(turn.taskId);
          return refusal(
            X402_ERROR_CODES.SETTLEMENT_FAILED,
            receipt.errorReason ?? 'Payment settlement failed.',
            receipt,
          );
        }
        await this.cleanup(turn.taskId, { retainX402Entry: true });
        return {
          kind: 'handled',
          operation: 'batch-refund',
          response: verification.skipHandler,
          receipt,
          receiptMetadata: buildX402PaymentCompletedMetadata({ receipt }),
        };
      }

      try {
        await this.initializeDeliveryAudit(turn.taskId);
      } catch (error) {
        const canceled = await this.cancelVerification(
          turn.taskId,
          verification.cancellation,
          'after_verify_aborted',
        );
        if (canceled) {
          try {
            await this.offerStore.release(turn.taskId);
          } catch (releaseError) {
            await this.reportError(releaseError, { operation: 'cleanup', taskId: turn.taskId });
          }
        }
        throw error;
      }

      if ((pricing.scheme ?? 'exact') === 'exact' && this.options.exactTiming === 'before-work') {
        const receipt = await this.options.x402.settle(turn, classified);
        if (!receipt.success) {
          const lifecycle = await this.options.x402.store.get(turn.taskId);
          if (lifecycle?.failure?.indeterminate === true) {
            await this.reportError(new Error(lifecycle.failure.reason), {
              operation: 'open',
              taskId: turn.taskId,
            });
            return refusal(
              X402_ERROR_CODES.SETTLEMENT_FAILED,
              'Payment settlement outcome is unavailable.',
            );
          }
          await this.cleanup(turn.taskId);
          return refusal(
            X402_ERROR_CODES.SETTLEMENT_FAILED,
            receipt.errorReason ?? 'Payment settlement failed.',
            receipt,
          );
        }
        await this.cleanup(turn.taskId, { retainX402Entry: true });
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

  /** Persist publication intent before the host exposes paid content. */
  async authorizeDelivery(
    input: MerchantGateAuthorizeDeliveryInput,
  ): Promise<MerchantGateAuthorizeDeliveryOutcome> {
    try {
      if (input.notAfter && !Number.isFinite(input.notAfter.getTime())) {
        throw new Error('Delivery publication deadline must be a valid Date.');
      }
      const metadataByStatus = new Map<'verified' | 'completed', Record<string, unknown>>();
      for (let attempt = 0; attempt < MAX_DELIVERY_AUTHORIZATION_ATTEMPTS; attempt += 1) {
        if (input.notAfter && Date.now() >= input.notAfter.getTime()) {
          return { kind: 'blocked', reason: 'payment-state-unavailable' };
        }
        const entry = await this.options.x402.store.get(input.taskId);
        if (!entry?.merchantDelivery) {
          return { kind: 'blocked', reason: 'payment-state-unavailable' };
        }
        if (entry.merchantDelivery.publicationClosedAt) {
          return { kind: 'blocked', reason: 'payment-state-unavailable' };
        }
        if (entry.status === 'failed' || entry.status === 'rejected') {
          return { kind: 'blocked', reason: 'payment-failed' };
        }
        if (entry.status !== 'verified' && entry.status !== 'completed') {
          return { kind: 'blocked', reason: 'payment-not-verified' };
        }
        if (
          entry.merchantDelivery.timing === 'after-settlement' &&
          entry.status !== 'completed'
        ) {
          return { kind: 'blocked', reason: 'settlement-required' };
        }

        const provisional = entry.status !== 'completed';
        let metadata = metadataByStatus.get(entry.status);
        if (!metadata) {
          metadata = structuredClone(
            (await this.options.deliveryMetadata?.({
              taskId: input.taskId,
              timing: entry.merchantDelivery.timing,
              provisional,
              paymentStatus: provisional ? 'verified' : 'settled',
            })) ?? {},
          );
          metadataByStatus.set(entry.status, metadata);
        }
        if (input.notAfter && Date.now() >= input.notAfter.getTime()) {
          return { kind: 'blocked', reason: 'payment-state-unavailable' };
        }
        const publicationStartedAt =
          entry.merchantDelivery.publicationStartedAt ?? new Date();
        const updatedStatus =
          await this.options.x402.store.updateMerchantDeliveryIfStatus(
            input.taskId,
            [entry.status],
            { publicationStartedAt },
            {
              publicationClosed: false,
              ...(input.notAfter ? { notAfter: input.notAfter } : {}),
            },
          );
        if (updatedStatus === undefined) continue;
        return { kind: 'authorized', provisional, metadata };
      }
      throw new Error('Delivery publication intent lost repeated lifecycle races.');
    } catch (error) {
      await this.reportError(error, {
        operation: 'authorize-delivery',
        taskId: input.taskId,
      });
      return { kind: 'blocked', reason: 'payment-state-unavailable' };
    }
  }

  /** Read whether the write-ahead publication boundary has been crossed. */
  async publicationStarted(taskId: string): Promise<boolean> {
    const entry = await this.options.x402.store.get(taskId);
    return entry?.merchantDelivery?.publicationStartedAt !== undefined;
  }

  async settle(input: MerchantGateSettleInput): Promise<MerchantGateSettleOutcome> {
    return await this.finishSettlement(input, 'completed');
  }

  /**
   * Finish failed work. Once publication was authorized, settlement still runs;
   * otherwise the verified authorization is canceled or lapsed without charge.
   */
  async abort(input: MerchantGateAbortInput): Promise<MerchantGateAbortOutcome> {
    try {
      if (input.obligation.kind === 'settled') {
        return await this.finishSettlement(
          {
            taskId: input.taskId,
            obligation: input.obligation,
            ...(input.usage === undefined ? {} : { usage: input.usage }),
          },
          'failed',
        );
      }

      const delivery = await this.closeUnpublishedDelivery(input.taskId);
      if (delivery === 'published') {
        return await this.finishSettlement(
          {
            taskId: input.taskId,
            obligation: input.obligation,
            ...(input.usage === undefined ? {} : { usage: input.usage }),
          },
          'failed',
        );
      }

      await this.recordWorkOutcome(input.taskId, 'failed');
      if (
        input.obligation.kind === 'deferred' &&
        input.obligation.scheme === 'batch-settlement'
      ) {
        if (!(await this.abortBatch(input))) {
          throw new Error('Batch reservation cancellation could not be confirmed.');
        }
      } else {
        await this.cleanup(input.taskId, { failOnError: true });
      }
      return { kind: 'aborted' };
    } catch (error) {
      await this.reportError(error, { operation: 'abort', taskId: input.taskId });
      return {
        kind: 'failed',
        code: X402_ERROR_CODES.SETTLEMENT_FAILED,
        reason: 'Payment delivery state is unavailable.',
      };
    }
  }

  private async finishSettlement(
    input: MerchantGateSettleInput,
    workOutcome: 'completed' | 'failed',
  ): Promise<MerchantGateSettleOutcome> {
    try {
      try {
        await this.recordWorkOutcome(input.taskId, workOutcome);
      } catch (error) {
        await this.reportError(error, { operation: 'settle', taskId: input.taskId });
      }
      const outcome = await this.settleObligation(input);
      let hasCompletedLifecycle = false;
      let hasPublished = false;
      let canCancelBatch = false;
      const isBatch =
        input.obligation.kind === 'deferred' &&
        input.obligation.scheme === 'batch-settlement';
      if (outcome.kind === 'settled') {
        await this.cleanup(input.taskId, { retainX402Entry: true });
      } else {
        const lifecycle = await this.options.x402.store.get(input.taskId);
        hasCompletedLifecycle = lifecycle?.status === 'completed';
        hasPublished = lifecycle?.merchantDelivery?.publicationStartedAt !== undefined;
        if (isBatch && !hasCompletedLifecycle && !hasPublished) {
          if (lifecycle?.status === 'verified' && lifecycle.merchantDelivery) {
            hasPublished =
              (await this.closeUnpublishedDelivery(input.taskId)) === 'published';
            canCancelBatch = !hasPublished;
          } else if (
            lifecycle?.status === 'failed' &&
            lifecycle.failure?.indeterminate !== true
          ) {
            canCancelBatch = true;
          }
        }
        if (hasPublished) {
          try {
            await this.recordSettlementFailure(input.taskId);
          } catch (error) {
            await this.reportError(error, { operation: 'settle', taskId: input.taskId });
          }
        }
        if (lifecycle?.failure?.indeterminate === true) {
          await this.reportError(new Error(lifecycle.failure.reason), {
            operation: 'settle',
            taskId: input.taskId,
          });
          return {
            kind: 'failed',
            code: X402_ERROR_CODES.SETTLEMENT_FAILED,
            reason: 'Payment settlement outcome is unavailable.',
          };
        }
      }
      if (outcome.kind === 'failed' && isBatch && canCancelBatch) {
        await this.abortBatch({
          taskId: input.taskId,
          obligation: input.obligation,
          reason: 'handler_failed',
        });
      }
      return outcome;
    } catch (error) {
      // Do not abort a batch obligation here. `x402.settle()` can reject after
      // the resource server has settled successfully but lifecycle persistence
      // has failed. A missing indeterminate marker is therefore not proof that
      // settlement did not escape; releasing the claim could allow duplicate work.
      await this.reportError(error, { operation: 'settle', taskId: input.taskId });
      return {
        kind: 'failed',
        code: X402_ERROR_CODES.SETTLEMENT_FAILED,
        reason: 'Payment settlement failed.',
      };
    }
  }

  /** Release retryable batch state only when no content escaped. */
  private async abortBatch(input: MerchantGateAbortInput): Promise<boolean> {
    if (
      input.obligation.kind !== 'deferred' ||
      input.obligation.scheme !== 'batch-settlement'
    ) {
      return true;
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
      return false;
    }
    try {
      await this.offerStore.release(input.taskId);
      return true;
    } catch (error) {
      await this.reportError(error, { operation: 'abort', taskId: input.taskId });
      return false;
    }
  }

  /** Let an unused held authorization expire without attempting settlement. */
  async lapse(taskId: string): Promise<void> {
    if ((await this.closeUnpublishedDelivery(taskId)) === 'published') {
      throw new MerchantDeliveryPublishedError();
    }
    await this.cleanup(taskId, { failOnError: true });
  }

  private async closeUnpublishedDelivery(
    taskId: string,
  ): Promise<'closed' | 'published'> {
    for (let attempt = 0; attempt < MAX_DELIVERY_AUTHORIZATION_ATTEMPTS; attempt += 1) {
      const entry = await this.options.x402.store.get(taskId);
      if (!entry) return 'closed';
      if (entry.merchantDelivery?.publicationStartedAt) return 'published';
      if (entry.merchantDelivery?.publicationClosedAt) return 'closed';
      if (!entry.merchantDelivery || entry.status !== 'verified') {
        throw new Error('Merchant delivery state cannot be closed from its current lifecycle.');
      }
      const closedAt = new Date();
      const updated = await this.options.x402.store.updateMerchantDeliveryIfStatus(
        taskId,
        ['verified'],
        { publicationClosedAt: closedAt },
        { publicationStarted: false },
      );
      if (updated !== undefined) return 'closed';
    }
    throw new Error('Merchant delivery closure lost repeated lifecycle races.');
  }

  private async initializeDeliveryAudit(taskId: string): Promise<void> {
    const updatedStatus =
      await this.options.x402.store.updateMerchantDeliveryIfStatus(
        taskId,
        ['verified'],
        { timing: this.options.deliveryTiming },
      );
    if (updatedStatus !== 'verified') {
      throw new Error('Merchant delivery policy was not persisted.');
    }
    const recorded = await this.options.x402.store.get(taskId);
    if (recorded?.merchantDelivery?.timing !== this.options.deliveryTiming) {
      throw new Error('Merchant delivery policy was not persisted.');
    }
  }

  private async recordWorkOutcome(
    taskId: string,
    outcome: 'completed' | 'failed',
  ): Promise<void> {
    const entry = await this.options.x402.store.get(taskId);
    if (!entry?.merchantDelivery) return;
    const updated = await this.options.x402.store.updateMerchantDelivery(
      taskId,
      outcome === 'completed'
        ? { workCompletedAt: new Date() }
        : { workFailedAt: new Date() },
    );
    if (!updated) throw new Error('Merchant work outcome was not persisted.');
    const recorded = await this.options.x402.store.get(taskId);
    const recordedAt =
      outcome === 'completed'
        ? recorded?.merchantDelivery?.workCompletedAt
        : recorded?.merchantDelivery?.workFailedAt;
    if (recordedAt === undefined) throw new Error('Merchant work outcome was not persisted.');
  }

  private async recordSettlementFailure(taskId: string): Promise<void> {
    const entry = await this.options.x402.store.get(taskId);
    if (!entry?.merchantDelivery) return;
    const updated = await this.options.x402.store.updateMerchantDelivery(taskId, {
      settlementFailedAt: new Date(),
    });
    if (!updated) throw new Error('Merchant settlement failure was not persisted.');
    const recorded = await this.options.x402.store.get(taskId);
    if (recorded?.merchantDelivery?.settlementFailedAt === undefined) {
      throw new Error('Merchant settlement failure was not persisted.');
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
    options: { retainX402Entry?: boolean; failOnError?: boolean } = {},
  ): Promise<void> {
    const sharesLifecycleStore = Object.is(this.offerStore, this.options.x402.store);
    const operations = [() => {
      if (options.retainX402Entry && this.offerStore.deleteOffer) {
        return this.offerStore.deleteOffer(taskId);
      }
      if (options.retainX402Entry && sharesLifecycleStore) {
        throw new Error(
          'MerchantGate: a shared offer/lifecycle store must implement deleteOffer() ' +
            'to retain lifecycle state without retaining merchant terms.',
        );
      }
      return this.offerStore.delete(taskId);
    }];
    if (!options.retainX402Entry) {
      operations.push(() => this.options.x402.clearOffering({ taskId }));
    }
    const failures: unknown[] = [];
    for (const operation of operations) {
      try {
        await operation();
      } catch (error) {
        failures.push(error);
        await this.reportError(error, { operation: 'cleanup', taskId });
      }
    }
    if (options.failOnError && failures.length > 0) {
      throw new AggregateError(failures, 'MerchantGate cleanup did not complete.');
    }
  }

  private async replayRefusal(
    taskId: string,
  ): Promise<Extract<MerchantGateOpenOutcome, { kind: 'refuse' }> | undefined> {
    const lifecycle = await this.options.x402.store.get(taskId);
    if (lifecycle?.status === 'completed') {
      return refusal(
        X402_ERROR_CODES.DUPLICATE_NONCE,
        'This task already has a completed payment.',
      );
    }
    if (lifecycle?.status === 'rejected') {
      return refusal(
        lifecycle.failure?.code ?? X402_ERROR_CODES.INVALID_PAYLOAD,
        lifecycle.failure?.reason ?? 'The payment was rejected for this task.',
      );
    }
    if (lifecycle?.merchantDelivery?.publicationClosedAt) {
      return refusal(
        X402_ERROR_CODES.DUPLICATE_NONCE,
        'This task already has a closed merchant delivery attempt.',
      );
    }
    const claimStatus = await this.offerStore.getClaimStatus?.(taskId);
    if (claimStatus === 'claimed') {
      return refusal(
        X402_ERROR_CODES.DUPLICATE_NONCE,
        'This payment is already in progress or has been submitted for this task.',
      );
    }
    return undefined;
  }

  private async cancelVerification(
    taskId: string,
    cancellation: X402PaymentCancellation | undefined,
    reason: X402VerifiedPaymentCancellationReason,
  ): Promise<boolean> {
    try {
      await cancellation?.cancel({ reason });
      return true;
    } catch (error) {
      await this.reportError(error, { operation: 'abort', taskId });
      return false;
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
