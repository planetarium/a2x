/**
 * Lazy loader for the optional x402 runtime peers (`@x402/core`, `@x402/evm`).
 *
 * Both are optional peer dependencies imported only when a payment actually
 * signs, verifies, or settles. That laziness is deliberate — non-x402
 * consumers must not be forced to install them, and bundlers must not pull
 * them in — but it means a missing peer stays invisible through install,
 * typecheck, and startup, and then fails inside a live payment round-trip.
 * Routing every optional import through here turns that raw
 * `ERR_MODULE_NOT_FOUND` into an actionable `X402PeerMissingError`.
 */

import { X402PeerMissingError } from './errors.js';

/** Resolution failures that mean "the package isn't installed / reachable". */
const MODULE_NOT_FOUND_CODES = new Set([
  'ERR_MODULE_NOT_FOUND',
  'MODULE_NOT_FOUND',
  'ERR_PACKAGE_PATH_NOT_EXPORTED',
]);

/** `@x402/core/http` → `@x402/core`; `viem/accounts` → `viem`. */
function packageNameOf(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@')
    ? segments.slice(0, 2).join('/')
    : segments[0]!;
}

/**
 * True when `err` means `packageName` itself could not be resolved.
 *
 * @internal Exported for tests — not part of `@a2x/sdk/x402`'s public surface.
 */
export function isMissingPeer(err: unknown, packageName: string): boolean {
  const code = (err as { code?: unknown } | undefined)?.code;
  if (typeof code !== 'string' || !MODULE_NOT_FOUND_CODES.has(code)) {
    return false;
  }
  // A module-not-found raised from *inside* the peer (its own broken
  // transitive dep) must not be relabelled "peer not installed" — only claim
  // that when the unresolvable specifier is the peer itself.
  const message = err instanceof Error ? err.message : '';
  return message.includes(packageName);
}

/**
 * Dynamically import an optional x402 peer, translating a missing-package
 * failure into `X402PeerMissingError`. Any other error (including a failure
 * from inside the peer's own module evaluation) propagates untouched.
 */
export async function importX402Peer(
  specifier: string,
): Promise<Record<string, unknown>> {
  try {
    // Keep the specifier opaque to bundlers that statically inspect dynamic
    // imports, so the peer is not required unless this path executes.
    return await import(/* @vite-ignore */ specifier);
  } catch (err) {
    const packageName = packageNameOf(specifier);
    if (isMissingPeer(err, packageName)) {
      throw new X402PeerMissingError(specifier, packageName, { cause: err });
    }
    throw err;
  }
}
