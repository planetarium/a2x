/**
 * V2 wire codec (x402Version: 2).
 *
 * Encodes an agent's `X402Accept` offerings into the x402 Foundation V2
 * `payment-required` envelope: CAIP-2 network ids, `amount`, and a single
 * top-level `resource` object hoisted out of the per-option requirements.
 *
 * V2 models one protected resource with several payment options, so the
 * top-level `resource` is taken from the first offering; all offerings for a
 * single `payment-required` are expected to describe the same resource.
 */

import { X402_DEFAULT_TIMEOUT_SECONDS } from './constants.js';
import { toCaip2 } from './networks.js';
import type {
  X402Accept,
  X402PaymentRequiredResponseV2,
  X402PaymentRequirementsV2,
  X402ResourceInfo,
} from './types.js';

const DEFAULT_EXTRA = { name: 'USDC', version: '2' } as const;

/** Encode one `X402Accept` into a V2 `PaymentRequirements` (resource hoisted out). */
export function encodeRequirementV2(
  accept: X402Accept,
): X402PaymentRequirementsV2 {
  return {
    scheme: accept.scheme ?? 'exact',
    network: toCaip2(accept.network),
    asset: accept.asset,
    amount: accept.amount,
    payTo: accept.payTo,
    maxTimeoutSeconds: accept.maxTimeoutSeconds ?? X402_DEFAULT_TIMEOUT_SECONDS,
    extra: accept.extra ?? { ...DEFAULT_EXTRA },
  };
}

/** Build the top-level V2 `resource` object from an offering. */
function resourceFrom(accept: X402Accept): X402ResourceInfo {
  return {
    url: accept.resource,
    description: accept.description,
    mimeType: accept.mimeType ?? 'application/json',
  };
}

/** Encode a list of offerings into the V2 `payment-required` payload. */
export function encodePaymentRequiredV2(
  accepts: X402Accept[],
  options?: { error?: string },
): X402PaymentRequiredResponseV2 {
  const first = accepts[0];
  if (!first) {
    throw new Error('encodePaymentRequiredV2: at least one offering is required');
  }
  return {
    x402Version: 2,
    resource: resourceFrom(first),
    accepts: accepts.map(encodeRequirementV2),
    ...(options?.error ? { error: options.error } : {}),
  };
}
