/**
 * Facilitator adapter. Wraps the `useFacilitator()` helper from
 * `x402/verify` so the SDK's `X402PaymentExecutor` can stay agnostic of
 * the underlying x402 package surface.
 *
 * The default Coinbase-hosted facilitator lives at `https://x402.org/facilitator`
 * but callers can point to any URL or inject a fully custom
 * `{ verify, settle }` pair for testing / self-hosted facilitators.
 */

import { useFacilitator, type CreateHeaders } from 'x402/verify';
import type { X402Facilitator } from './types.js';

/** Default facilitator URL used by the Coinbase reference implementation. */
export const X402_DEFAULT_FACILITATOR_URL = 'https://x402.org/facilitator';

export interface FacilitatorUrlConfig {
  /** URL of a hosted facilitator. Default: `https://x402.org/facilitator`. */
  url?: string;
  /** Optional auth-header minter for facilitators that require signed requests. */
  createAuthHeaders?: CreateHeaders;
}

/**
 * Resolve a user-supplied facilitator spec into the minimal
 * `{ verify, settle }` pair the SDK needs.
 *
 * Accepts:
 *  - a URL config object — constructs an `useFacilitator()` under the hood
 *  - an already-implemented `X402Facilitator` — passed through
 *  - `undefined` — uses `useFacilitator()` with defaults
 */
export function resolveFacilitator(
  spec: FacilitatorUrlConfig | X402Facilitator | undefined,
): X402Facilitator {
  if (spec && 'verify' in spec && 'settle' in spec) {
    return spec;
  }

  const urlSpec = spec as FacilitatorUrlConfig | undefined;
  const url = (urlSpec?.url ?? X402_DEFAULT_FACILITATOR_URL) as `https://${string}`;
  const { verify, settle } = useFacilitator({
    url,
    ...(urlSpec?.createAuthHeaders
      ? { createAuthHeaders: urlSpec.createAuthHeaders }
      : {}),
  });

  return {
    verify: async (payload, requirements) =>
      verify(
        payload as Parameters<typeof verify>[0],
        requirements as Parameters<typeof verify>[1],
      ),
    settle: async (payload, requirements) =>
      settle(
        payload as Parameters<typeof settle>[0],
        requirements as Parameters<typeof settle>[1],
      ),
  };
}
