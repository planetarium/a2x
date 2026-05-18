/**
 * `@a2x/sdk/x402` — a2a-x402 v0.2 payment support.
 *
 * Adds on-chain payment gating to A2A agents using the Coinbase x402
 * protocol. See `specification/a2a-x402-v0.2.md` for the wire format.
 *
 * The SDK exposes spec mechanics as **stateless helpers**, never as a
 * flow: the agent owns when to request payment, what offerings it
 * advertised, how to validate the submitted payment, whether to retry
 * after failure, and what to do between `facilitator.verify` and
 * `facilitator.settle`. The SDK does not persist payment state or
 * auto-route resume turns.
 *
 * Minimal server setup:
 *
 * ```ts
 * import {
 *   A2XAgent, AgentExecutor, BaseAgent, StreamingMode,
 *   x402RequestPayment, parseX402PaymentSubmission, pickX402Requirement,
 *   validateX402PayloadShape, normalizeX402Accept,
 *   buildX402PaymentCompletedMetadata, buildX402PaymentFailedMetadata,
 *   mapVerifyFailureToCode, resolveFacilitator, X402_EXTENSION_URI,
 * } from '@a2x/sdk';
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
 * const agent = new A2XAgent({ taskStore, executor })
 *   .setName('Paid Agent')
 *   .addExtension({ uri: X402_EXTENSION_URI, required: true });
 * ```
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
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
  X402_ERROR_CODES,
  X402_DEFAULT_TIMEOUT_SECONDS,
  mapVerifyFailureToCode,
  type X402PaymentStatus,
  type X402ErrorCode,
} from './constants.js';

export type {
  X402Accept,
  X402Facilitator,
  X402PaymentRequirements,
  X402PaymentPayload,
  X402PaymentRequiredResponse,
  X402SettleResponse,
  X402VerifyResponse,
  X402Network,
} from './types.js';

// Server-side surface: stateless helpers.
export {
  buildX402PaymentRequiredMetadata,
  x402RequestPayment,
  parseX402PaymentSubmission,
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
  X402EvmAuthorization,
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

export {
  resolveFacilitator,
  X402_DEFAULT_FACILITATOR_URL,
} from './facilitator.js';
export type { FacilitatorUrlConfig } from './facilitator.js';

export {
  signX402Payment,
  rejectX402Payment,
  getX402PaymentRequirements,
  getX402Receipts,
  getX402Status,
} from './client.js';
export type {
  SignX402PaymentOptions,
  SignedX402Payment,
} from './client.js';

export {
  X402Error,
  X402PaymentRequiredError,
  X402PaymentFailedError,
  X402NoSupportedRequirementError,
  X402InvalidVersionError,
} from './errors.js';
