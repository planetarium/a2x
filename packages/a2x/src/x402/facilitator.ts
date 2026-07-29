/**
 * Facilitator adapter. Wraps `@x402/core`'s `HTTPFacilitatorClient` so the
 * SDK's x402 server flow can stay agnostic of the underlying package
 * surface.
 *
 * One client serves both protocol versions: `HTTPFacilitatorClient.verify/settle`
 * echo the payload's `x402Version`, and its response schemas accept both
 * bare-name (V1) and CAIP-2 (V2) networks — so a single facilitator client
 * verifies and settles V1 and V2 payments with no up-conversion.
 *
 * The default hosted facilitator lives at `https://x402.org/facilitator`,
 * but callers can point to any URL or inject a fully custom
 * `{ verify, settle }` pair for testing / self-hosted facilitators.
 *
 * `@x402/core` is an optional peer dependency, imported lazily so bundlers
 * skip it unless the verify/settle path actually executes.
 */

import { importX402Peer } from './peer.js';
import type { X402Facilitator } from './types.js';

/** Default facilitator URL used by the hosted reference implementation. */
export const X402_DEFAULT_FACILITATOR_URL = 'https://x402.org/facilitator';

/**
 * Mints auth headers for facilitators that require signed requests. Shape
 * is forwarded verbatim to `HTTPFacilitatorClient`; typed loosely so the
 * SDK does not couple to the peer's exact signature.
 */
export type X402CreateAuthHeaders = (...args: unknown[]) => unknown;

export interface FacilitatorUrlConfig {
  /** URL of a hosted facilitator. Default: `https://x402.org/facilitator`. */
  url?: string;
  /** Optional auth-header minter for facilitators that require signed requests. */
  createAuthHeaders?: X402CreateAuthHeaders;
}

interface HttpFacilitatorClient {
  verify(payload: unknown, requirements: unknown): Promise<unknown>;
  settle(payload: unknown, requirements: unknown): Promise<unknown>;
}

type HttpFacilitatorModule = {
  HTTPFacilitatorClient: new (config: {
    url: string;
    createAuthHeaders?: X402CreateAuthHeaders;
  }) => HttpFacilitatorClient;
};

function isX402Facilitator(
  spec: FacilitatorUrlConfig | X402Facilitator | undefined,
): spec is X402Facilitator {
  return !!spec && 'verify' in spec && 'settle' in spec;
}

/**
 * Resolve a user-supplied facilitator spec into the minimal
 * `{ verify, settle }` pair the SDK needs.
 *
 * Accepts:
 *  - a URL config object — constructs an `HTTPFacilitatorClient` lazily
 *  - an already-implemented `X402Facilitator` — passed through
 *  - `undefined` — uses the default hosted facilitator
 */
export function resolveFacilitator(
  spec?: FacilitatorUrlConfig | X402Facilitator,
): X402Facilitator {
  if (isX402Facilitator(spec)) {
    return spec;
  }

  const urlSpec = spec as FacilitatorUrlConfig | undefined;
  const url = urlSpec?.url ?? X402_DEFAULT_FACILITATOR_URL;

  let clientPromise: Promise<HttpFacilitatorClient> | undefined;
  const client = () => {
    if (!clientPromise) {
      clientPromise = (async () => {
        const mod = (await importX402Peer(
          ['@x402', 'core/http'].join('/'),
        )) as unknown as HttpFacilitatorModule;
        return new mod.HTTPFacilitatorClient({
          url,
          ...(urlSpec?.createAuthHeaders
            ? { createAuthHeaders: urlSpec.createAuthHeaders }
            : {}),
        });
      })();
      // Don't memoize a failure: `X402PeerMissingError` tells the operator to
      // install the peers, and in a long-running server a cached rejection
      // would keep failing after they did.
      const pending = clientPromise;
      pending.catch(() => {
        if (clientPromise === pending) clientPromise = undefined;
      });
    }
    return clientPromise;
  };

  return {
    verify: async (payload, requirements) => {
      const c = await client();
      try {
        return (await c.verify(
          payload,
          requirements,
        )) as Awaited<ReturnType<X402Facilitator['verify']>>;
      } catch (err) {
        // HTTPFacilitatorClient throws (VerifyError) on a non-2xx response
        // even when the body is a usable `{isValid:false, invalidReason}` —
        // unwrap it back into a normal negative result so callers branch on
        // `isValid` instead of catching. Genuine transport/schema errors (no
        // structured body) still propagate.
        const body = extractFacilitatorErrorBody(err);
        if (body && 'isValid' in body) {
          return body as Awaited<ReturnType<X402Facilitator['verify']>>;
        }
        throw err;
      }
    },
    settle: async (payload, requirements) => {
      const c = await client();
      try {
        return (await c.settle(
          payload,
          requirements,
        )) as Awaited<ReturnType<X402Facilitator['settle']>>;
      } catch (err) {
        const body = extractFacilitatorErrorBody(err);
        if (body && 'success' in body) {
          return body as Awaited<ReturnType<X402Facilitator['settle']>>;
        }
        throw err;
      }
    },
  };
}

/**
 * `@x402/core`'s `VerifyError`/`SettleError` carry the parsed facilitator
 * response body on `.response` (a `{isValid:false,…}` / `{success:false,…}`
 * object). Extract it when present so a "facilitator says invalid" result is
 * treated as data, not an exception.
 */
function extractFacilitatorErrorBody(
  err: unknown,
): Record<string, unknown> | undefined {
  const response = (err as { response?: unknown })?.response;
  return response && typeof response === 'object'
    ? (response as Record<string, unknown>)
    : undefined;
}
