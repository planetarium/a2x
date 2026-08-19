/**
 * The optional x402 peers (`@x402/core`, `@x402/evm`) are imported lazily on
 * the first sign / verify / settle, so a missing install stays invisible
 * through typecheck and startup and then fails inside a live payment. These
 * tests pin the translation of that failure into an actionable error, and
 * that a genuine failure from *inside* a peer is not mislabelled.
 */

import { describe, it, expect } from 'vitest';
import { importX402Peer, isMissingPeer } from '../x402/peer.js';
import { X402PeerMissingError } from '../x402/index.js';

/** Shape of Node's ESM resolution failure for an uninstalled package. */
function moduleNotFound(specifier: string): Error & { code: string } {
  const err = new Error(
    `Cannot find package '${specifier}' imported from /app/node_modules/@a2x/sdk/dist/index.js`,
  ) as Error & { code: string };
  err.code = 'ERR_MODULE_NOT_FOUND';
  return err;
}

describe('importX402Peer', () => {
  it('resolves a peer that is installed', async () => {
    const mod = await importX402Peer(['@x402', 'core/http'].join('/'));
    expect(mod).toBeTruthy();
    expect('HTTPFacilitatorClient' in mod).toBe(true);
  });

  it('translates a missing package into an actionable X402PeerMissingError', async () => {
    // Import a scoped package that does not exist, so Node raises the real
    // ERR_MODULE_NOT_FOUND rather than a hand-rolled stand-in.
    const specifier = ['@x402', 'definitely-not-installed'].join('/');
    await expect(importX402Peer(specifier)).rejects.toThrow(X402PeerMissingError);

    const err = await importX402Peer(specifier).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(X402PeerMissingError);
    const peerErr = err as X402PeerMissingError;
    expect(peerErr.packageName).toBe(specifier);
    expect(peerErr.specifier).toBe(specifier);
    // The whole point: the message must name what to install.
    expect(peerErr.message).toContain('npm install @x402/core @x402/evm viem');
    // And point upgraders at the peer rename.
    expect(peerErr.message).toContain('`x402`');
    // The original resolution error stays attached for debugging.
    expect((peerErr as { cause?: unknown }).cause).toBeInstanceOf(Error);
  });

  it('derives the bare package name from a subpath specifier', async () => {
    const err = (await importX402Peer(
      ['@x402', 'definitely-not-installed', 'deep', 'subpath'].join('/'),
    ).catch((e: unknown) => e)) as X402PeerMissingError;
    expect(err.packageName).toBe(['@x402', 'definitely-not-installed'].join('/'));
    expect(err.specifier).toContain('deep/subpath');
  });

  it('prefers a host-registered loader over runtime module resolution', async () => {
    const registrySymbol = Symbol.for('@a2x/sdk/x402-peer-loaders');
    const runtime = globalThis as unknown as Record<PropertyKey, unknown>;
    const previous = runtime[registrySymbol];
    const expected = { HTTPFacilitatorClient: class {} };
    runtime[registrySymbol] = {
      '@x402/core/http': async () => expected,
    };
    try {
      await expect(importX402Peer('@x402/core/http')).resolves.toBe(expected);
    } finally {
      if (previous === undefined) delete runtime[registrySymbol];
      else runtime[registrySymbol] = previous;
    }
  });
});

describe('isMissingPeer — does not over-claim', () => {
  it('rejects a module-not-found raised from inside the peer', () => {
    // A peer that IS installed but whose own transitive dep is broken raises
    // ERR_MODULE_NOT_FOUND naming that dep, not the peer. Relabelling it
    // "peer not installed" would send the operator down the wrong path.
    expect(isMissingPeer(moduleNotFound('some-transitive-dep'), '@x402/core')).toBe(
      false,
    );
  });

  it('accepts a module-not-found naming the peer itself', () => {
    expect(isMissingPeer(moduleNotFound('@x402/core'), '@x402/core')).toBe(true);
  });

  it('rejects a non-resolution error', () => {
    const other = new Error('facilitator exploded') as Error & { code: string };
    other.code = 'ERR_INVALID_ARG_TYPE';
    expect(isMissingPeer(other, '@x402/core')).toBe(false);
  });

  it('rejects an error with no code at all', () => {
    expect(isMissingPeer(new Error('@x402/core blew up'), '@x402/core')).toBe(false);
    expect(isMissingPeer(undefined, '@x402/core')).toBe(false);
  });

  it('accepts the CJS and export-map resolution codes too', () => {
    for (const code of ['MODULE_NOT_FOUND', 'ERR_PACKAGE_PATH_NOT_EXPORTED']) {
      const err = moduleNotFound('@x402/core');
      err.code = code;
      expect(isMissingPeer(err, '@x402/core')).toBe(true);
    }
  });
});
