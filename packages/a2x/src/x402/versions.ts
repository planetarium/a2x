/**
 * x402 protocol-version model — the seam between a2x's version-agnostic logic
 * and the two wire versions (V1 / V2).
 *
 * a2x's server/client logic (matching, validation, budget, receipts) is
 * written once against version-agnostic accessors; the only places that
 * know about a specific version's envelope are the wire codecs
 * (`wire-v1.ts` / `wire-v2.ts`) and these accessors. Detection is total:
 * both `payment-required` and `payment-payload` envelopes carry
 * `x402Version`, so any object can be classified as x402Version 1 or 2.
 */

import { sameNetwork } from './networks.js';
import type {
  X402PaymentPayload,
  X402PaymentRequirements,
  X402PaymentRequirementsV1,
  X402PaymentRequirementsV2,
} from './types.js';

/** The two x402 protocol versions a2x speaks on the wire. */
export type X402Version = 1 | 2;

/** Protocol versions this SDK can emit, sign, and settle. */
export const X402_SUPPORTED_VERSIONS: readonly X402Version[] = [1, 2];

/**
 * Version `X402Context` speaks when the deployment doesn't configure one.
 *
 * A server emits exactly one version — its configured
 * `X402ContextOptions.x402Version` — because the activation channel cannot
 * express a version request: the foundation URI is version-neutral and
 * there is no URI that means "send me V2". Every known peer implementation is
 * likewise single-version (the upstream `x402_a2a` reference lineage
 * speaks V1 only, Bindu speaks V2 only), so per-request negotiation has
 * nothing to negotiate with.
 *
 * **V1** by default: it is what the upstream reference library and its
 * derivatives decode, and handing V2 to a peer that never proved it speaks V2
 * would be a silent wire break. A deployment whose clients speak V2 opts in
 * with `new X402Context({ x402Version: 2 })` (and advertises the foundation
 * URI on its card).
 */
export const X402_DEFAULT_VERSION: X402Version = 1;

/** True when `version` is an x402Version this SDK supports. */
export function isSupportedVersion(version: unknown): version is X402Version {
  return version === 1 || version === 2;
}

/**
 * Classify a `payment-required` / `payment-payload` envelope (or a bare
 * `x402Version`) by x402Version. Returns `undefined` for anything that is
 * not a supported version, so callers can reject with the spec's
 * `invalid_x402_version` code.
 */
export function detectX402Version(
  input: { x402Version?: unknown } | number | undefined,
): X402Version | undefined {
  const version = typeof input === 'number' ? input : input?.x402Version;
  return isSupportedVersion(version) ? version : undefined;
}

// ─── Version-agnostic requirement accessors ───

function isV2Requirement(
  req: X402PaymentRequirements,
): req is X402PaymentRequirementsV2 {
  return typeof (req as X402PaymentRequirementsV2).amount === 'string';
}

/** Maximum payable amount, whichever version the requirement is in. */
export function requirementAmount(req: X402PaymentRequirements): string {
  return isV2Requirement(req)
    ? req.amount
    : (req as X402PaymentRequirementsV1).maxAmountRequired;
}

/**
 * Clone `req` with its amount replaced, writing whichever field the
 * requirement's encoded version uses (`maxAmountRequired` for V1, `amount`
 * for V2). Used by metered settlement under usage-based schemes.
 *
 * @internal Not part of `@a2x/sdk/x402`'s public surface.
 */
export function withRequirementAmount(
  req: X402PaymentRequirements,
  amount: string,
): X402PaymentRequirements {
  return isV2Requirement(req)
    ? { ...req, amount }
    : { ...(req as X402PaymentRequirementsV1), maxAmountRequired: amount };
}

/** Network id (bare name for V1, CAIP-2 for V2). */
export function requirementNetwork(req: X402PaymentRequirements): string {
  return req.network;
}

/** Payment scheme (`"exact"`, `"upto"`, …). */
export function requirementScheme(req: X402PaymentRequirements): string {
  return req.scheme;
}

/** Recipient wallet address. */
export function requirementPayTo(req: X402PaymentRequirements): string {
  return req.payTo;
}

// ─── Version-agnostic payload accessors ───

/**
 * The requirement the client committed to when signing: V1 carries
 * `scheme`/`network` at the top level; V2 echoes the full requirement under
 * `accepted`. Returns `{ network, scheme }` in both cases.
 */
export function payloadCommitment(
  payload: X402PaymentPayload,
): { network: string; scheme: string } | undefined {
  if (payload.x402Version === 2) {
    const accepted = payload.accepted;
    if (!accepted) return undefined;
    return { network: accepted.network, scheme: accepted.scheme };
  }
  if (payload.x402Version === 1) {
    return { network: payload.network, scheme: payload.scheme };
  }
  return undefined;
}

/**
 * Network the payment settled/authorized on, read from the payload for
 * receipt construction. V1 has it top-level; V2 reads it from `accepted`.
 * Returns `''` when the payload cannot name one (a V2 payload with no
 * `accepted` echo) — callers holding the matched requirement should fall
 * back to `requirement.network`.
 */
export function payloadNetwork(payload: X402PaymentPayload): string {
  return payloadCommitment(payload)?.network ?? '';
}

/**
 * True when a payment payload matches an offered requirement — same scheme
 * and same network (cross-version network equivalence applied, so a V1
 * bare name and a V2 CAIP-2 id for the same chain match).
 */
export function payloadMatchesRequirement(
  payload: X402PaymentPayload,
  req: X402PaymentRequirements,
): boolean {
  const commitment = payloadCommitment(payload);
  if (!commitment) return false;
  return (
    commitment.scheme === req.scheme &&
    sameNetwork(commitment.network, req.network)
  );
}
