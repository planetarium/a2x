/**
 * a2a-x402 v0.2 protocol constants.
 *
 * The x402 Payments Extension bolts HTTP 402 "Payment Required" semantics
 * onto A2A tasks. Clients advertise the extension URI in their AgentCard
 * `capabilities.extensions` array and transport payment state through
 * message metadata using the `x402.payment.*` keys defined below.
 *
 * Spec: specification/a2a-x402-v0.2.md
 */

/** Canonical URI for a2a-x402 v0.2. */
export const X402_EXTENSION_URI =
  'https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2';

/** Metadata keys used inside `message.metadata` for x402 payment coordination. */
export const X402_METADATA_KEYS = {
  /** Current payment lifecycle stage. Required on every x402 message. */
  STATUS: 'x402.payment.status',
  /** `X402PaymentRequiredResponse` published by the merchant. */
  REQUIRED: 'x402.payment.required',
  /** Signed `PaymentPayload` sent by the client. */
  PAYLOAD: 'x402.payment.payload',
  /** Array of `X402SettleResponse` receipts attached to the completed task. */
  RECEIPTS: 'x402.payment.receipts',
  /** Short error code string when payment fails. */
  ERROR: 'x402.payment.error',
} as const;

/** All payment status values defined by the spec's state machine. */
export const X402_PAYMENT_STATUS = {
  REQUIRED: 'payment-required',
  SUBMITTED: 'payment-submitted',
  REJECTED: 'payment-rejected',
  VERIFIED: 'payment-verified',
  COMPLETED: 'payment-completed',
  FAILED: 'payment-failed',
} as const;

export type X402PaymentStatus =
  (typeof X402_PAYMENT_STATUS)[keyof typeof X402_PAYMENT_STATUS];

/**
 * Error codes the SDK emits via `X402_METADATA_KEYS.ERROR`.
 *
 * The codes from spec §9.1 "Common Error Codes" are wire-identical to the
 * spec. Additional SDK-specific codes cover failure modes the SDK detects
 * before or outside the facilitator's purview (payload shape problems,
 * configuration mismatches) and are documented as proprietary extensions
 * of §9.1's open list.
 */
export const X402_ERROR_CODES = {
  // ─── Spec §9.1 — use these verbatim for wire compatibility ───
  INSUFFICIENT_FUNDS: 'INSUFFICIENT_FUNDS',
  INVALID_SIGNATURE: 'INVALID_SIGNATURE',
  EXPIRED_PAYMENT: 'EXPIRED_PAYMENT',
  DUPLICATE_NONCE: 'DUPLICATE_NONCE',
  NETWORK_MISMATCH: 'NETWORK_MISMATCH',
  INVALID_AMOUNT: 'INVALID_AMOUNT',
  SETTLEMENT_FAILED: 'SETTLEMENT_FAILED',
  // ─── SDK-specific (outside spec §9.1) ───
  /** Payment payload is missing, unparseable, or structurally invalid. */
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  /** Authorization target address does not match the advertised `payTo`. */
  INVALID_PAY_TO: 'INVALID_PAY_TO',
  /**
   * Fallback for verify failures whose `invalidReason` doesn't map to a
   * more specific spec §9.1 code. Prefer the specific code when possible.
   */
  VERIFY_FAILED: 'VERIFY_FAILED',
} as const;

export type X402ErrorCode =
  (typeof X402_ERROR_CODES)[keyof typeof X402_ERROR_CODES];

/**
 * Map a facilitator's `invalidReason` string to a spec §9.1 error code.
 *
 * Facilitator implementations (including the Coinbase reference one)
 * return free-form reason strings that embed the actual failure cause.
 * We do best-effort substring matching so clients can branch on the
 * well-known spec codes instead of scraping prose. When no substring
 * matches, returns `VERIFY_FAILED` so the caller always has something.
 */
export function mapVerifyFailureToCode(
  invalidReason: string | undefined,
): X402ErrorCode {
  if (!invalidReason) return X402_ERROR_CODES.VERIFY_FAILED;
  const reason = invalidReason.toLowerCase();
  if (
    reason.includes('insufficient_funds') ||
    reason.includes('insufficient_balance') ||
    reason.includes('insufficient-balance')
  ) {
    return X402_ERROR_CODES.INSUFFICIENT_FUNDS;
  }
  if (
    reason.includes('nonce_reused') ||
    reason.includes('duplicate_nonce') ||
    reason.includes('nonce_used') ||
    reason.includes('used_nonce')
  ) {
    return X402_ERROR_CODES.DUPLICATE_NONCE;
  }
  if (
    reason.includes('expired') ||
    reason.includes('valid_before') ||
    reason.includes('validbefore') ||
    reason.includes('valid_after') ||
    reason.includes('validafter')
  ) {
    return X402_ERROR_CODES.EXPIRED_PAYMENT;
  }
  if (
    reason.includes('invalid_signature') ||
    reason.includes('signature_invalid') ||
    reason.includes('bad_signature')
  ) {
    return X402_ERROR_CODES.INVALID_SIGNATURE;
  }
  if (
    reason.includes('network_mismatch') ||
    reason.includes('wrong_network')
  ) {
    return X402_ERROR_CODES.NETWORK_MISMATCH;
  }
  if (
    reason.includes('invalid_amount') ||
    reason.includes('amount_mismatch')
  ) {
    return X402_ERROR_CODES.INVALID_AMOUNT;
  }
  return X402_ERROR_CODES.VERIFY_FAILED;
}

/** Default maximum payment completion window per `PaymentRequirements.maxTimeoutSeconds`. */
export const X402_DEFAULT_TIMEOUT_SECONDS = 300;

/** Sentinel resource tag the SDK uses when the caller doesn't specify one. */
export const X402_DEFAULT_RESOURCE = 'a2a-x402/access';
