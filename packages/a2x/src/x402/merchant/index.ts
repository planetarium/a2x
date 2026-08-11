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
  InMemoryMerchantOfferingSidecar,
  type InMemoryMerchantOfferingSidecarOptions,
  type MerchantOfferingSidecar,
} from './sidecar.js';
export type {
  MerchantDeferredObligation,
  MerchantDetailedRates,
  MerchantExactPricing,
  MerchantExactTiming,
  MerchantGateOpenInput,
  MerchantGateOpenOutcome,
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
  MerchantMeteredCharge,
} from './types.js';
