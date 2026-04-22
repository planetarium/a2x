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

/** Error codes the SDK may emit via `X402_METADATA_KEYS.ERROR`. */
export const X402_ERROR_CODES = {
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  NETWORK_MISMATCH: 'NETWORK_MISMATCH',
  INVALID_PAY_TO: 'INVALID_PAY_TO',
  AMOUNT_EXCEEDED: 'AMOUNT_EXCEEDED',
  VERIFY_FAILED: 'VERIFY_FAILED',
  SETTLE_FAILED: 'SETTLE_FAILED',
  NO_REQUIREMENTS: 'NO_REQUIREMENTS',
} as const;

export type X402ErrorCode =
  (typeof X402_ERROR_CODES)[keyof typeof X402_ERROR_CODES];

/** Default maximum payment completion window per `PaymentRequirements.maxTimeoutSeconds`. */
export const X402_DEFAULT_TIMEOUT_SECONDS = 300;

/** Sentinel resource tag the SDK uses when the caller doesn't specify one. */
export const X402_DEFAULT_RESOURCE = 'a2a-x402/access';
