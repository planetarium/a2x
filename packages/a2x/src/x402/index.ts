/**
 * `@a2x/sdk/x402` — a2a-x402 v0.2 payment support.
 *
 * Adds on-chain payment gating to A2A agents using the Coinbase x402
 * protocol. See `specification/a2a-x402-v0.2.md` for the wire format.
 *
 * Minimal server setup:
 *
 * ```ts
 * import { A2XAgent, AgentExecutor } from '@a2x/sdk';
 * import { X402PaymentExecutor, X402_EXTENSION_URI } from '@a2x/sdk/x402';
 *
 * const inner = new AgentExecutor({ runner, runConfig });
 * const executor = new X402PaymentExecutor(inner, {
 *   accepts: [{
 *     network: 'base-sepolia',
 *     amount: '10000',                                // 0.01 USDC
 *     asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
 *     payTo: '0xYourMerchantAddress',
 *   }],
 * });
 *
 * const agent = new A2XAgent({ taskStore, executor })
 *   .setName('Paid Agent')
 *   .setDescription('Charges per call')
 *   .setCapabilities({
 *     extensions: [{ uri: X402_EXTENSION_URI, required: true }],
 *   });
 * ```
 *
 * Minimal client setup:
 *
 * ```ts
 * import { A2XClient } from '@a2x/sdk/client';
 * import { X402Client } from '@a2x/sdk/x402';
 * import { privateKeyToAccount } from 'viem/accounts';
 *
 * const x402 = new X402Client(new A2XClient(url), {
 *   signer: privateKeyToAccount(process.env.PRIVATE_KEY),
 * });
 *
 * const task = await x402.sendMessage({ message: { … } });
 * ```
 */

export {
  X402_EXTENSION_URI,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
  X402_ERROR_CODES,
  X402_DEFAULT_TIMEOUT_SECONDS,
  X402_DEFAULT_RESOURCE,
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

export { X402PaymentExecutor } from './executor.js';
export type { X402PaymentExecutorOptions } from './executor.js';

export {
  resolveFacilitator,
  X402_DEFAULT_FACILITATOR_URL,
} from './facilitator.js';
export type { FacilitatorUrlConfig } from './facilitator.js';

export {
  signX402Payment,
  getX402PaymentRequirements,
  getX402Receipts,
  getX402Status,
  X402Client,
} from './client.js';
export type {
  SignX402PaymentOptions,
  SignedX402Payment,
  X402ClientOptions,
} from './client.js';

export {
  X402Error,
  X402PaymentRequiredError,
  X402PaymentFailedError,
  X402NoSupportedRequirementError,
} from './errors.js';
