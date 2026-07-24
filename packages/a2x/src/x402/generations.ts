/**
 * x402 generation model — the seam between a2x's generation-agnostic logic
 * and the two wire generations (V1 / V2).
 *
 * a2x's server/client logic (matching, validation, budget, receipts) is
 * written once against generation-agnostic accessors; the only places that
 * know about a specific generation's envelope are the wire codecs
 * (`wire-v1.ts` / `wire-v2.ts`) and these accessors. Detection is total:
 * both `payment-required` and `payment-payload` envelopes carry
 * `x402Version`, so any object can be classified as generation 1 or 2.
 */

import { sameNetwork } from './networks.js';
import type {
  X402PaymentPayload,
  X402PaymentRequirements,
  X402PaymentRequirementsV1,
  X402PaymentRequirementsV2,
} from './types.js';

/** The two x402 protocol generations a2x speaks on the wire. */
export type X402Generation = 1 | 2;

/** Generations this SDK can emit, sign, and settle. */
export const X402_SUPPORTED_VERSIONS: readonly X402Generation[] = [1, 2];

/**
 * Fallback generation the server emits when the client's activation set
 * pins no x402 URI (e.g. a transport that stripped `X-A2A-Extensions`, or a
 * client that activated nothing). V1 during the transition window: it is the
 * migration-safe choice for legacy clients, and any V2-capable client
 * negotiates *up* to V2 by activating the V2 URI. Deployments that have fully
 * migrated can override this to `2` via `X402ContextOptions.defaultGeneration`.
 */
export const X402_DEFAULT_GENERATION: X402Generation = 1;

/** True when `version` is a generation this SDK supports. */
export function isSupportedVersion(version: unknown): version is X402Generation {
  return version === 1 || version === 2;
}

/**
 * Classify a `payment-required` / `payment-payload` envelope (or a bare
 * `x402Version`) by generation. Returns `undefined` for anything that is
 * not a supported generation, so callers can reject with the spec's
 * `invalid_x402_version` code.
 */
export function detectGeneration(
  input: { x402Version?: unknown } | number | undefined,
): X402Generation | undefined {
  const version = typeof input === 'number' ? input : input?.x402Version;
  return isSupportedVersion(version) ? version : undefined;
}

// ─── Generation-agnostic requirement accessors ───

function isV2Requirement(
  req: X402PaymentRequirements,
): req is X402PaymentRequirementsV2 {
  return typeof (req as X402PaymentRequirementsV2).amount === 'string';
}

/** Maximum payable amount, whichever generation the requirement is in. */
export function requirementAmount(req: X402PaymentRequirements): string {
  return isV2Requirement(req)
    ? req.amount
    : (req as X402PaymentRequirementsV1).maxAmountRequired;
}

/** Network id (bare name for V1, CAIP-2 for V2). */
export function requirementNetwork(req: X402PaymentRequirements): string {
  return req.network;
}

/** Payment scheme (`"exact"`). */
export function requirementScheme(req: X402PaymentRequirements): string {
  return req.scheme;
}

/** Recipient wallet address. */
export function requirementPayTo(req: X402PaymentRequirements): string {
  return req.payTo;
}

// ─── Generation-agnostic payload accessors ───

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
 */
export function payloadNetwork(payload: X402PaymentPayload): string {
  return payloadCommitment(payload)?.network ?? '';
}

/**
 * True when a payment payload matches an offered requirement — same scheme
 * and same network (cross-generation network equivalence applied, so a V1
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
