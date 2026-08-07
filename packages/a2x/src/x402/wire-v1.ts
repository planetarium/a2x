/**
 * V1 wire codec (x402Version: 1).
 *
 * Encodes an agent's `X402Accept` offerings into the legacy V1
 * `payment-required` envelope: bare network names, `maxAmountRequired`, and
 * `resource`/`description`/`mimeType` inline on each requirement. This is
 * the byte shape a2a-x402 v0.2 clients and the V1 facilitator expect.
 */

import { schemeExtra } from './assets.js';
import { X402_DEFAULT_TIMEOUT_SECONDS } from './constants.js';
import { toBareName } from './networks.js';
import type {
  X402Accept,
  X402PaymentRequiredResponseV1,
  X402PaymentRequirementsV1,
} from './types.js';

/** Encode one `X402Accept` into a V1 `PaymentRequirements`. */
export function encodeRequirementV1(
  accept: X402Accept,
): X402PaymentRequirementsV1 {
  const scheme = accept.scheme ?? 'exact';
  // `upto` and `batch-settlement` exist only in x402 V2. `@x402/evm` has no
  // `registerV1` path for either, and their settlement lifecycles read V2
  // fields (`accepted.scheme`, `requirements.amount`), so advertising one in
  // V1 can only dead-end. Refusing it here — before `requestPayment` persists
  // an entry — turns that into a configuration error the operator can act on.
  if (scheme === 'upto' || scheme === 'batch-settlement') {
    throw new Error(
      `encodeRequirementV1: the "${scheme}" scheme is x402 V2 only and cannot be encoded ` +
        'under x402Version 1. Configure the server with `new X402Context({ x402Version: 2 })` ' +
        `to offer ${scheme} payments.`,
    );
  }
  return {
    scheme,
    network: toBareName(accept.network),
    maxAmountRequired: accept.amount,
    resource: accept.resource,
    description: accept.description,
    mimeType: accept.mimeType ?? 'application/json',
    payTo: accept.payTo,
    maxTimeoutSeconds: accept.maxTimeoutSeconds ?? X402_DEFAULT_TIMEOUT_SECONDS,
    asset: accept.asset,
    ...schemeExtra(scheme, accept),
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
