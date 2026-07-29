/**
 * a2a-x402 protocol constants, shared by both wire generations.
 *
 * The x402 Payments Extension bolts HTTP 402 "Payment Required" semantics
 * onto A2A tasks. Clients advertise the extension URI in their AgentCard
 * `capabilities.extensions` array and transport payment state through
 * message metadata using the `x402.payment.*` keys defined below.
 *
 * The `x402.payment.*` keys and the extension URIs below are generation-neutral
 * — see `generations.ts` for the V1/V2 split.
 *
 * Spec: specification/x402-transport-a2a-v1.md, -v2.md
 */

/**
 * URI declared by `spec/v0.2/spec.md` of the a2a-x402 extension repo. a2x
 * treats a client that activates it as **V1-only**: every wire structure that
 * spec defines is V1-shaped (`x402Version: 1`, bare network names,
 * `maxAmountRequired`), and no document anywhere pairs this URI with V2
 * envelopes. A V1 server accepts the activation; a V2 server refuses to serve
 * it (see `BaseX402Context.requestPayment`) rather than emit envelopes the
 * client cannot decode — or worse, emit V2 under a URI whose defining spec
 * says V1, which would reproduce the exact URI/generation ambiguity the
 * foundation URI already suffers from.
 *
 * Counterintuitively this is the *newer* extension spec of the two URIs here:
 * both come from the same upstream repo (`google-agentic-commerce/a2a-x402`),
 * which declares a different URI per spec version — v0.1 declares
 * `X402_FOUNDATION_EXTENSION_URI`, v0.2 declares this one. A2A requires that
 * (`topics/extensions`: "A new URI MUST be used when introducing a breaking
 * change"), so the two URIs are legitimately distinct identifiers rather than
 * aliases. The x402 Foundation's A2A transport docs nonetheless standardized
 * on the v0.1 URI, which is why a2x advertises that one and keeps this as a
 * backward-compatible input only.
 *
 * Retained for the transition window; new deployments should advertise
 * `X402_FOUNDATION_EXTENSION_URI` instead.
 *
 * @deprecated as an AgentCard-advertised URI — advertise
 * `X402_FOUNDATION_EXTENSION_URI` instead. Registering it from a client
 * (`extensions: [X402_EXTENSION_URI]`) remains supported as an explicit
 * "this client decodes V1 only" declaration: V1 agents serve it, V2 agents
 * fail it fast with `invalid_x402_version`.
 */
export const X402_EXTENSION_URI =
  'https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2';

/**
 * The URI the x402 Foundation's A2A transport specs mandate. Declared by
 * `spec/v0.1/spec.md` of the a2a-x402 extension repo, and by the foundation's
 * `transports-v2/a2a.md` (and its V1 predecessor) verbatim.
 *
 * IMPORTANT: this URI is **generation-neutral** — the foundation V1 *and* V2
 * transport docs declare the *same* URI, so the generation is signalled by
 * `x402Version` *inside* the envelope, not by the URI. The `v0.1` in the path
 * is the *extension spec's* version, not the x402 protocol generation.
 *
 * Note this is the *older* of the two extension specs a2x knows: the same
 * upstream repo also ships v0.2, which declares `X402_EXTENSION_URI`. The
 * foundation transport standardized on v0.1 regardless, so advertising this
 * URI while emitting V2 envelopes is correct even though it reads backwards.
 *
 * Neither URI is registered in A2A's official `a2a-protocol.org/extensions/`
 * namespace; both are vendor-declared. The path is an identifier, not a
 * fetchable document (it has no `/tree/` or `/blob/` segment).
 *
 * a2x advertises this as the canonical x402 extension. It is **not** an input
 * to generation selection: activating it is not proof the client speaks V2,
 * only that it speaks x402-on-A2A. Because no activation URI can express a
 * generation, an a2x server does not negotiate one — it emits the single
 * generation its deployment configured (`X402ContextOptions.generation`),
 * which is how every other known implementation behaves too (the upstream
 * `x402_a2a` reference lineage is V1-only, Bindu is V2-only; both activate
 * this same URI).
 */
export const X402_FOUNDATION_EXTENSION_URI =
  'https://github.com/google-a2a/a2a-x402/v0.1';

/**
 * The x402 extension activation family — the two spec versions of the same
 * upstream extension (v0.1 and v0.2) that a2x recognizes as advertising x402
 * payment support.
 *
 * A2A treats a per-version URI as a distinct extension, so an agent that
 * requires one and a client that activated the other would normally fail the
 * activation check. `_validateExtensionActivation` treats these two as an
 * any-of group instead — an a2x-server-specific relaxation of A2A's
 * per-extension `required` rule — so a client speaking either version gets
 * through the migration window. a2x implements only the Standalone flow,
 * which is unchanged between the two versions, so accepting either is safe.
 */
export const X402_EXTENSION_URIS: readonly string[] = [
  X402_FOUNDATION_EXTENSION_URI,
  X402_EXTENSION_URI,
];

/** True when the URI is a member of the x402 activation family. */
export function isX402ExtensionUri(uri: string): boolean {
  return X402_EXTENSION_URIS.includes(uri);
}

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
  /**
   * x402-v1 §9 `invalid_x402_version`: protocol version is not supported.
   * Emitted client-side when the merchant publishes `x402Version` ≠ 1;
   * the x402 npm package pins `x402Versions: [1]`, so anything else is
   * unsigned-and-rejected before we hand the requirement to
   * `createPaymentHeader()`.
   *
   * The wire value is intentionally lowercase: a2a-x402 v0.2 §9.1 only
   * defines seven UPPERCASE codes (INSUFFICIENT_FUNDS, …, SETTLEMENT_FAILED)
   * — `invalid_x402_version` isn't one of them. Following x402-v1 §9
   * verbatim is more correct than coining an upper-cased a2a-x402
   * variant that no spec defines.
   */
  INVALID_X402_VERSION: 'invalid_x402_version',
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
