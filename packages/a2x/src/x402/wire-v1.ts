/**
 * V1 wire codec (x402Version: 1).
 *
 * Encodes an agent's `X402Accept` offerings into the legacy V1
 * `payment-required` envelope: bare network names, `maxAmountRequired`, and
 * `resource`/`description`/`mimeType` inline on each requirement. This is
 * the byte shape a2a-x402 v0.2 clients and the V1 facilitator expect.
 */

import { X402_DEFAULT_TIMEOUT_SECONDS } from './constants.js';
import { toBareName } from './networks.js';
import type {
  X402Accept,
  X402PaymentRequiredResponseV1,
  X402PaymentRequirementsV1,
} from './types.js';

const DEFAULT_EXTRA = { name: 'USDC', version: '2' } as const;

/** Encode one `X402Accept` into a V1 `PaymentRequirements`. */
export function encodeRequirementV1(
  accept: X402Accept,
): X402PaymentRequirementsV1 {
  return {
    scheme: accept.scheme ?? 'exact',
    network: toBareName(accept.network),
    maxAmountRequired: accept.amount,
    resource: accept.resource,
    description: accept.description,
    mimeType: accept.mimeType ?? 'application/json',
    payTo: accept.payTo,
    maxTimeoutSeconds: accept.maxTimeoutSeconds ?? X402_DEFAULT_TIMEOUT_SECONDS,
    asset: accept.asset,
    extra: accept.extra ?? { ...DEFAULT_EXTRA },
  };
}

/** Encode a list of offerings into the V1 `payment-required` payload. */
export function encodePaymentRequiredV1(
  accepts: X402Accept[],
  options?: { error?: string },
): X402PaymentRequiredResponseV1 {
  return {
    x402Version: 1,
    accepts: accepts.map(encodeRequirementV1),
    ...(options?.error ? { error: options.error } : {}),
  };
}
