/**
 * Bundle-safe x402 peer loaders for the standalone CLI.
 *
 * The SDK deliberately keeps these optional imports opaque, but @yao-pkg/pkg
 * executes its CommonJS snapshot without a dynamic-import callback. Literal
 * specifiers here let esbuild include each peer and replace import() with its
 * internal module initializer before pkg sees the bundle.
 */

type X402PeerModule = Record<string, unknown>;
type X402PeerLoader = () => Promise<X402PeerModule>;

const loaders = {
  '@x402/core/client': async () =>
    (await import('@x402/core/client')) as unknown as X402PeerModule,
  '@x402/evm/exact/client': async () =>
    (await import('@x402/evm/exact/client')) as unknown as X402PeerModule,
  '@x402/evm/upto/client': async () =>
    (await import('@x402/evm/upto/client')) as unknown as X402PeerModule,
} satisfies Record<string, X402PeerLoader>;

const registrySymbol = Symbol.for('@a2x/sdk/x402-peer-loaders');
const runtime = globalThis as unknown as Record<PropertyKey, unknown>;
const registered = runtime[registrySymbol];
runtime[registrySymbol] = {
  ...(registered && typeof registered === 'object' ? registered : {}),
  ...loaders,
};
