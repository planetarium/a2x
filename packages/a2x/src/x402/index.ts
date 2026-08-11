/**
 * `@a2x/sdk/x402` — a2a-x402 payment support (protocol versions V1 and V2).
 *
 * Adds on-chain payment gating to A2A agents using the x402 protocol. Wire
 * formats: `specification/x402-transport-a2a-v1.md` (plus its
 * `specification/a2a-x402-v0.2.md` lineage) for V1, and
 * `specification/x402-transport-a2a-v2.md` for V2. Version is signalled by
 * `x402Version` inside the envelope, not by the extension URI. A server
 * speaks exactly one version — V1 unless the deployment opts into
 * `new X402Context({ x402Version: 2 })` — and the client signs whatever it
 * receives.
 *
 * The low-level spec mechanics are **stateless helpers**. `MerchantGate` is
 * an optional, host-neutral composition over those helpers: the host still
 * owns paid/free selection, pricing lookup, settlement timing, missing-usage
 * policy, outcome rendering, and durable storage. Nothing in this entry point
 * auto-installs payment behavior or auto-routes resume turns.
 *
 * Minimal server setup:
 *
 * ```ts
 * import { A2XServer, AgentExecutor, BaseAgent, StreamingMode } from '@a2x/sdk';
 * import {
 *   x402RequestPayment, parseX402PaymentSubmission, pickX402Requirement,
 *   validateX402PayloadShape, normalizeX402Accept,
 *   buildX402PaymentCompletedMetadata, buildX402PaymentFailedMetadata,
 *   mapVerifyFailureToCode, resolveFacilitator, X402_FOUNDATION_EXTENSION_URI,
 * } from '@a2x/sdk/x402';
 *
 * const ACCEPTS = [{
 *   network: 'base-sepolia',
 *   amount: '10000',
 *   asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
 *   payTo: '0xYourMerchantAddress',
 *   resource: 'https://api.example.com/premium',
 *   description: 'Premium agent access',
 * }];
 *
 * class PaidAgent extends BaseAgent {
 *   constructor(private readonly facilitator) { super({ name: 'paid' }); }
 *
 *   async *run(ctx) {
 *     const submitted = parseX402PaymentSubmission(ctx.message!);
 *
 *     // Turn 1 — no payment yet.
 *     if (!submitted) {
 *       yield* x402RequestPayment({ accepts: ACCEPTS });
 *       return;
 *     }
 *
 *     // Turn 2 — validate against what we offered (here: a constant; in
 *     // production, look up by ctx.taskId from your durable store).
 *     const requirements = ACCEPTS.map(normalizeX402Accept);
 *     const requirement = pickX402Requirement(submitted.payload!, requirements);
 *     if (!requirement) {
 *       yield {
 *         type: 'error',
 *         error: new Error('Submitted payment does not match any advertised option.'),
 *         metadata: buildX402PaymentFailedMetadata({
 *           code: 'NETWORK_MISMATCH',
 *           reason: 'Submitted network/scheme does not match any offered option.',
 *         }),
 *       };
 *       return;
 *     }
 *
 *     const issues = validateX402PayloadShape(submitted.payload!, requirement);
 *     if (issues.length > 0) {
 *       yield {
 *         type: 'error',
 *         error: new Error(issues[0]!.reason),
 *         metadata: buildX402PaymentFailedMetadata({ code: issues[0]!.code, reason: issues[0]!.reason }),
 *       };
 *       return;
 *     }
 *
 *     const verify = await this.facilitator.verify(submitted.payload!, requirement);
 *     if (!verify.isValid) {
 *       yield {
 *         type: 'error',
 *         error: new Error(verify.invalidReason ?? 'verify failed'),
 *         metadata: buildX402PaymentFailedMetadata({
 *           code: mapVerifyFailureToCode(verify.invalidReason),
 *           reason: verify.invalidReason ?? 'Payment verification failed.',
 *         }),
 *       };
 *       return;
 *     }
 *
 *     const settle = await this.facilitator.settle(submitted.payload!, requirement);
 *     if (!settle.success) {
 *       yield {
 *         type: 'error',
 *         error: new Error(settle.errorReason ?? 'settle failed'),
 *         metadata: buildX402PaymentFailedMetadata({
 *           code: 'SETTLEMENT_FAILED',
 *           reason: settle.errorReason ?? 'Payment settlement failed.',
 *         }),
 *       };
 *       return;
 *     }
 *
 *     yield { type: 'text', role: 'agent', text: 'thanks for paying' };
 *     yield {
 *       type: 'done',
 *       metadata: buildX402PaymentCompletedMetadata({
 *         receipt: {
 *           success: true,
 *           transaction: settle.transaction ?? '',
 *           network: submitted.payload!.network,
 *           payer: submitted.authorization?.from ?? 'unknown',
 *         },
 *       }),
 *     };
 *   }
 * }
 *
 * const facilitator = resolveFacilitator();
 * const agent = new A2XServer({ taskStore, executor })
 *   .setName('Paid Agent')
 *   .addExtension({ uri: X402_FOUNDATION_EXTENSION_URI, required: true });
 * ```
 *
 * Declare the foundation URI, not the legacy `X402_EXTENSION_URI`: it is the
 * URI the foundation transport mandates, and a2x treats the two as an
 * activation family, so a legacy v0.2 client still passes the `required`
 * check on a V1 server. (On an `x402Version: 2` server a v0.2 activation is
 * refused at `requestPayment` — that URI declares a V1-only client.)
 *
 * Minimal client setup (unchanged):
 *
 * ```ts
 * import { A2XClient } from '@a2x/sdk/client';
 * import { privateKeyToAccount } from 'viem/accounts';
 *
 * const client = new A2XClient(url, {
 *   x402: { signer: privateKeyToAccount(process.env.PRIVATE_KEY) },
 * });
 *
 * const task = await client.sendMessage({ message: { ... } });
 * ```
 *
 * `A2XClient` runs the Standalone Flow transparently — detect
 * `payment-required`, sign one of the merchant's `accepts[]`, resubmit
 * with the signed payload, and return the final task.
 */

export {
  X402_EXTENSION_URI,
  X402_FOUNDATION_EXTENSION_URI,
  X402_EXTENSION_URIS,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
  X402_ERROR_CODES,
  X402_DEFAULT_TIMEOUT_SECONDS,
  mapVerifyFailureToCode,
  isX402ExtensionUri,
  type X402PaymentStatus,
  type X402ErrorCode,
} from './constants.js';

export {
  X402_SUPPORTED_VERSIONS,
  X402_DEFAULT_VERSION,
  detectX402Version,
  isSupportedVersion,
  requirementAmount,
  requirementNetwork,
  requirementScheme,
  requirementPayTo,
  payloadNetwork,
  payloadMatchesRequirement,
  type X402Version,
} from './versions.js';

export type {
  X402Accept,
  X402Facilitator,
  X402ResourceServer,
  X402ResourceVerifyResponse,
  X402PaymentCancellation,
  X402SkipHandlerDirective,
  X402VerifiedPaymentCancellationReason,
  X402PaymentRequirements,
  X402PaymentRequirementsV1,
  X402PaymentRequirementsV2,
  X402PaymentPayload,
  X402PaymentPayloadV1,
  X402PaymentPayloadV2,
  X402PaymentRequiredResponse,
  X402PaymentRequiredResponseV1,
  X402PaymentRequiredResponseV2,
  X402ResourceInfo,
  X402SettleResponse,
  X402FacilitatorSettleResponse,
  X402VerifyResponse,
  X402Network,
  X402EvmAuthorization,
  X402ExactEvmPayload,
  X402Permit2Authorization,
  X402UptoEvmPayload,
} from './types.js';

// Server-side surface: stateless helpers.
export {
  buildX402PaymentRequiredMetadata,
  x402RequestPayment,
  parseX402PaymentSubmission,
  extractX402Payer,
  pickX402Requirement,
  validateX402PayloadShape,
  normalizeX402Accept,
  buildX402PaymentCompletedMetadata,
  buildX402PaymentFailedMetadata,
  buildX402PaymentVerifiedMetadata,
} from './payment.js';
export type {
  X402RequestPaymentInput,
  X402PaymentSubmission,
  X402ValidationIssue,
} from './payment.js';

// Server-side surface: high-level façade over the helpers above.
// `BaseX402Context` is the extension point for custom flows; `X402Context`
// is the default concrete implementation most callers instantiate.
export { BaseX402Context, X402Context } from './context.js';
export type {
  X402ContextOptions,
  X402ContextRequestPaymentInput,
  X402Classification,
  X402ValidClassification,
} from './context.js';

// Server-side surface: lifecycle store. `BaseX402Store` is the abstract
// contract for custom backends; `InMemoryX402Store` is the default
// concrete impl suitable for single-instance deployments.
export { BaseX402Store, InMemoryX402Store } from './store.js';
export type {
  X402StoreEntry,
  X402StoreEntryPatch,
  X402EntryStatus,
  X402EntryReceipt,
  X402EntryFailure,
  InMemoryX402StoreOptions,
} from './store.js';

// Optional merchant-policy composition. Hosts still own paid/free selection,
// rates, settlement timing, missing-usage behavior, and outcome rendering.
export {
  InMemoryMerchantOfferStore,
  InMemoryUptoSessionStore,
  MerchantGate,
  UptoSessionManager,
  merchantPricingToAccept,
  meterMerchantUsage,
  validateMerchantOffer,
} from './merchant/index.js';
export type {
  InMemoryMerchantOfferStoreOptions,
  InMemoryUptoSessionStoreOptions,
  MerchantOfferClaimStatus,
  MerchantDeferredObligation,
  MerchantBatchSettlementPricing,
  MerchantDetailedRates,
  MerchantExactPricing,
  MerchantExactTiming,
  MerchantGateErrorContext,
  MerchantGateAbortInput,
  MerchantGateOpenInput,
  MerchantGateOpenOutcome,
  MerchantGateOptions,
  MerchantGateSettleInput,
  MerchantGateSettleOutcome,
  MerchantMeterableUsage,
  MerchantMeteredPricing,
  MerchantMeteredCharge,
  MerchantOffer,
  MerchantOfferStore,
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
  UptoSessionEndReason,
  UptoSessionFinishTurnInput,
  UptoSessionManagerErrorContext,
  UptoSessionManagerOptions,
  UptoSessionObligation,
  UptoSessionOpenInput,
  UptoSessionOutcome,
  UptoSessionRecord,
  UptoSessionRecordTurnInput,
  UptoSessionRecovery,
  UptoSessionSettlement,
  UptoSessionSnapshot,
  UptoSessionState,
  UptoSessionStore,
  UptoSessionTurnInput,
  UptoSessionTurnStart,
} from './merchant/index.js';

export {
  resolveFacilitator,
  X402_DEFAULT_FACILITATOR_URL,
} from './facilitator.js';
export type { FacilitatorUrlConfig } from './facilitator.js';

export {
  signX402Payment,
  rejectX402Payment,
  reconcileX402BatchSettlement,
  getX402BatchSettlementBinding,
  getX402PaymentRequirements,
  getX402PaymentExtensions,
  getX402Receipts,
  getX402Status,
} from './client.js';
export type {
  SignX402PaymentOptions,
  SignedX402Payment,
  X402BatchSettlementOptions,
  X402BatchSettlementDepositPolicy,
  X402BatchSettlementDepositStrategy,
  X402BatchSettlementDepositContext,
  X402BatchSettlementBinding,
  X402BatchSettlementPayloadBinding,
  X402ClientChannelStorage,
  X402ChannelState,
} from './client.js';

export {
  X402Error,
  X402PaymentRequiredError,
  X402PaymentFailedError,
  X402NoSupportedRequirementError,
  X402InvalidVersionError,
  X402PeerMissingError,
  X402ReconciliationError,
  X402ChannelQuarantinedError,
  X402AttemptPendingError,
} from './errors.js';
