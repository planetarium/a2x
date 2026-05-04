/**
 * `@a2x/sdk/x402` — a2a-x402 v0.2 payment support.
 *
 * Adds on-chain payment gating to A2A agents using the Coinbase x402
 * protocol. See `specification/a2a-x402-v0.2.md` for the wire format.
 *
 * Server agents express payment gating inline by yielding
 * `request-input` AgentEvents from `BaseAgent.run()` — there is no
 * separate executor class to extend. The default `AgentExecutor`
 * handles the input-required round-trip when `inputRoundTripHooks`
 * includes `x402PaymentHook(...)`.
 *
 * Minimal server setup:
 *
 * ```ts
 * import {
 *   A2XAgent, AgentExecutor, BaseAgent, StreamingMode,
 *   x402PaymentHook, x402RequestPayment, readX402Settlement, X402_EXTENSION_URI,
 * } from '@a2x/sdk';
 *
 * const ACCEPTS = [{
 *   network: 'base-sepolia',
 *   amount: '10000',                                 // 0.01 USDC
 *   asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
 *   payTo: '0xYourMerchantAddress',
 *   resource: 'https://api.example.com/premium',
 *   description: 'Premium agent access',
 * }];
 *
 * class PaidAgent extends BaseAgent {
 *   async *run(context) {
 *     if (!readX402Settlement(context).paid) {
 *       yield* x402RequestPayment({ accepts: ACCEPTS });
 *       return;
 *     }
 *     yield { type: 'text', role: 'agent', text: 'thanks for paying' };
 *     yield { type: 'done' };
 *   }
 * }
 *
 * const executor = new AgentExecutor({
 *   runner,
 *   runConfig: { streamingMode: StreamingMode.SSE },
 *   inputRoundTripHooks: [x402PaymentHook()],
 * });
 *
 * const agent = new A2XAgent({ taskStore, executor })
 *   .setName('Paid Agent')
 *   .addExtension({ uri: X402_EXTENSION_URI, required: true });
 * ```
 *
 * Minimal client setup (unchanged from prior versions):
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

// Server-side surface (replaces X402PaymentExecutor).
export {
  X402_DOMAIN,
  x402RequestPayment,
  x402PaymentHook,
  readX402Settlement,
} from './payment.js';
export type {
  X402RequestPaymentInput,
  X402PaymentHookOptions,
} from './payment.js';

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
