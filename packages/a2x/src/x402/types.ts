/**
 * a2a-x402 v0.2 type definitions.
 *
 * We re-export the relevant types from the `x402` npm package so callers
 * don't need to import from two places, and we add the two wrapper shapes
 * the A2A extension layers on top of the base x402 protocol:
 *
 *  - `X402PaymentRequiredResponse` — the object a merchant agent publishes
 *    under `x402.payment.required` when asking for payment.
 *  - `X402SettleResponse` — the trimmed receipt the SDK attaches under
 *    `x402.payment.receipts` on the completed task.
 *
 * The base types come from x402 v1 (x402Version: 1) because a2a-x402 v0.2
 * pins to x402 v1 (see specification/a2a-x402-v0.2.md).
 */

import type {
  PaymentRequirements as X402PaymentRequirements,
  PaymentPayload as X402PaymentPayload,
  VerifyResponse as X402VerifyResponse,
  SettleResponse as X402FacilitatorSettleResponse,
  Network as X402Network,
} from 'x402/types';

export type {
  X402PaymentRequirements,
  X402PaymentPayload,
  X402VerifyResponse,
  X402Network,
};

/**
 * Top-level object published by the merchant under
 * `message.metadata['x402.payment.required']` in the Standalone Flow.
 *
 * Mirrors spec section 5.1 of a2a-x402 v0.2.
 */
export interface X402PaymentRequiredResponse {
  /** Protocol version — must be 1 for a2a-x402 v0.2 (pinned to x402 v1). */
  x402Version: 1;
  /** Payment options the merchant will accept; the client picks one. */
  accepts: X402PaymentRequirements[];
  /** Optional human-readable error string; populated when a prior submission failed. */
  error?: string;
}

/**
 * Settlement receipt attached to `message.metadata['x402.payment.receipts']`
 * on the task's final message. Matches x402-v1 §5.3 (SettlementResponse) +
 * a2a-x402 v0.2 §5.5 (the trimmed wire shape attached to A2A tasks).
 */
export interface X402SettleResponse {
  success: boolean;
  /** Transaction hash on success, empty string on failure. */
  transaction: string;
  /** Network the settlement occurred on. */
  network: string;
  /**
   * Address of the payer's wallet. Required by x402-v1 §5.3.2 on every
   * SettlementResponse — including failure rows, since post-settlement
   * audits / multi-wallet bookkeeping branch on this field. The SDK
   * propagates whatever the facilitator returns; for EVM "exact" payloads
   * it falls back to `authorization.from` if the facilitator omits it.
   */
  payer: string;
  /** Short error code (e.g. `VERIFY_FAILED`) when `success` is false. */
  errorReason?: string;
}

/**
 * Minimal shape the SDK needs from a payment facilitator.
 *
 * Matches the `verify`/`settle` functions returned by `useFacilitator()` from
 * `x402/verify`, but abstracted so callers can plug in a different backend
 * (mock facilitator in tests, a custom routing proxy, a different vendor).
 *
 * The structural types are kept loose (`unknown` in payload) to avoid a hard
 * coupling to any specific x402 package version; the SDK casts internally.
 */
export interface X402Facilitator {
  verify(
    payload: X402PaymentPayload,
    requirements: X402PaymentRequirements,
  ): Promise<X402VerifyResponse>;
  settle(
    payload: X402PaymentPayload,
    requirements: X402PaymentRequirements,
  ): Promise<X402FacilitatorSettleResponse>;
}

/**
 * What the caller gives the SDK when configuring x402 support. A single
 * `network`/`asset`/`amount`/`payTo` triple with sensible defaults for
 * everything else the spec demands (scheme, mime type, timeout, extra).
 *
 * `resource` and `description` are required by the x402 v1
 * `PaymentRequirements` schema — facilitators that validate strictly
 * reject non-URL `resource` and wallet UIs surface `description` as the
 * consent prompt for the user. The SDK fabricated these as
 * `'a2a-x402/access'` and `''` before #123, which shipped invalid wire
 * output to every paying client. They're now required at the API
 * boundary.
 */
export interface X402Accept {
  /** Blockchain network id (e.g. `"base-sepolia"`, `"base"`). */
  network: X402Network;
  /** Amount in the asset's smallest unit (USDC: 6 decimals → `"1000000"` = 1 USDC). */
  amount: string;
  /** Token contract address (for ERC-20) or asset identifier. */
  asset: string;
  /** Wallet address that should receive the payment. */
  payTo: string;
  /**
   * Human-readable description of the resource — shown to the paying
   * client, often as a wallet consent prompt. Required by x402 v1.
   */
  description: string;
  /**
   * URL of the protected resource. Required by x402 v1; strict
   * facilitators reject non-URL values. Use the public URL the client
   * is paying to access (e.g. `https://api.example.com/premium-data`).
   */
  resource: string;
  /** MIME type of the expected response. Defaults to `"application/json"`. */
  mimeType?: string;
  /** Payment expiry window in seconds. Defaults to 300. */
  maxTimeoutSeconds?: number;
  /** Scheme-specific extra fields (EIP-712 name/version for USDC etc.). */
  extra?: Record<string, unknown>;
  /** Payment scheme. Only `"exact"` is defined by the x402 v1 spec. */
  scheme?: 'exact';
}
