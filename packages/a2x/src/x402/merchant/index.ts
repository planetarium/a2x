/**
 * Optional merchant-policy composition for `@a2x/sdk/x402`.
 *
 * The module returns host-neutral outcomes and leaves event rendering, work,
 * pricing lookup, settlement timing, and missing-usage policy explicit.
 */
export {
  MerchantGate,
  type MerchantGateErrorContext,
  type MerchantGateOptions,
} from './gate.js';
export {
  merchantPricingToAccept,
  meterMerchantUsage,
  validateMerchantOffer,
} from './pricing.js';
export {
  InMemoryMerchantOfferStore,
  type InMemoryMerchantOfferStoreOptions,
  type MerchantOfferClaimStatus,
  type MerchantOfferStore,
} from './offer-store.js';
export {
  InMemoryUptoSessionStore,
  UptoSessionManager,
  type InMemoryUptoSessionStoreOptions,
  type UptoSessionCancelOpenInput,
  type UptoSessionCommitOpenInput,
  type UptoSessionEndReason,
  type UptoSessionFinishTurnInput,
  type UptoSessionManagerErrorContext,
  type UptoSessionManagerOptions,
  type UptoSessionObligation,
  type UptoSessionOpenInput,
  type UptoSessionOpenReservation,
  type UptoSessionOutcome,
  type UptoSessionRecord,
  type UptoSessionRecordTurnInput,
  type UptoSessionRecovery,
  type UptoSessionReserveOpenInput,
  type UptoSessionSettlement,
  type UptoSessionSnapshot,
  type UptoSessionState,
  type UptoSessionStore,
  type UptoSessionTurnInput,
  type UptoSessionTurnStart,
} from './session.js';
export type {
  MerchantDeferredObligation,
  MerchantBatchSettlementPricing,
  MerchantDetailedRates,
  MerchantExactPricing,
  MerchantExactTiming,
  MerchantGateOpenInput,
  MerchantGateOpenOutcome,
  MerchantGateAbortInput,
  MerchantGateSettleInput,
  MerchantGateSettleOutcome,
  MerchantOffer,
  MerchantObligation,
  MerchantPricing,
  MerchantPricingResolver,
  MerchantSettledCharge,
  MerchantSettledObligation,
  MerchantTotalRate,
  MerchantTurnRef,
  MerchantUnreportedUsagePolicy,
  MerchantUptoPricing,
  MerchantUsageRates,
  MerchantMeterableUsage,
  MerchantMeteredPricing,
  MerchantMeteredCharge,
} from './types.js';
