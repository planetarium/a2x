/**
 * Bare-name ↔ CAIP-2 network normalization.
 *
 * x402 V1 wire uses bare network names (`"base-sepolia"`); V2 wire uses
 * CAIP-2 ids (`"eip155:84532"`). `@x402/evm` exports an equivalent map, but
 * it is an optional peer the SDK loads lazily only on the signing path — so
 * a2x carries a matching table (kept in sync with `@x402/evm`) for the three
 * jobs it needs it for, without forcing the peer to be installed:
 *
 *  1. `X402Accept` normalization — agents configure `network` once (usually
 *     a bare name) and the V2 codec must emit the CAIP-2 form.
 *  2. Cross-generation equivalence — a wallet configured for `"base-sepolia"`
 *     must match a V2 requirement on `"eip155:84532"` when selecting a
 *     requirement or applying a budget filter.
 *  3. V1 emission — a CAIP-2 value entering a V1 requirement must be
 *     down-converted to the bare name the V1 facilitator/scheme expects.
 *
 * The EVM chain-id map mirrors `@x402/evm`'s `EVM_NETWORK_CHAIN_ID_MAP` so
 * any network that package's exact scheme supports round-trips here too.
 */

/** Bare EVM network name → EIP-155 chain id. Mirrors `@x402/evm`. */
const EVM_NETWORK_CHAIN_ID: Record<string, number> = {
  ethereum: 1,
  sepolia: 11155111,
  abstract: 2741,
  'abstract-testnet': 11124,
  'base-sepolia': 84532,
  base: 8453,
  'avalanche-fuji': 43113,
  avalanche: 43114,
  iotex: 4689,
  sei: 1329,
  'sei-testnet': 1328,
  polygon: 137,
  'polygon-amoy': 80002,
  peaq: 3338,
  story: 1514,
  educhain: 41923,
  'skale-base-sepolia': 324705682,
  megaeth: 4326,
  monad: 143,
  stable: 988,
  'stable-testnet': 2201,
};

/** EIP-155 chain id → bare EVM network name (inverse of the table above). */
const CHAIN_ID_TO_EVM_NETWORK: Record<number, string> = Object.fromEntries(
  Object.entries(EVM_NETWORK_CHAIN_ID).map(([name, id]) => [id, name]),
);

/** True when the value is already a CAIP-2 id (`namespace:reference`). */
export function isCaip2(network: string): boolean {
  return /^[a-z0-9-]+:[a-zA-Z0-9-]+$/.test(network);
}

/**
 * True when the network is an EVM chain the SDK's `exact` scheme can sign —
 * a known bare EVM name (V1) or an `eip155:<chainId>` CAIP-2 id (V2). Used to
 * avoid selecting an offering (e.g. a Solana rail in a multi-rail V2 offer)
 * the EVM signer cannot fulfil.
 */
export function isEvmNetwork(network: string): boolean {
  return network in EVM_NETWORK_CHAIN_ID || /^eip155:\d+$/.test(network);
}

/**
 * Normalize a network id to CAIP-2. Bare EVM names map through the chain-id
 * table to `eip155:<chainId>`. Values that are already CAIP-2 are returned
 * unchanged. Unknown bare names are returned as-is (best effort — the
 * facilitator will reject an unusable value).
 */
export function toCaip2(network: string): string {
  if (isCaip2(network)) return network;
  const chainId = EVM_NETWORK_CHAIN_ID[network];
  return chainId !== undefined ? `eip155:${chainId}` : network;
}

/**
 * Normalize a network id to its bare EVM name. CAIP-2 `eip155:<id>` maps
 * back through the chain-id table. Bare names are returned unchanged.
 * Throws when a CAIP-2 value has no known bare-name equivalent, since a V1
 * requirement carrying an unmappable network would be silently unsignable.
 */
export function toBareName(network: string): string {
  if (!isCaip2(network)) return network;
  const match = /^eip155:(\d+)$/.exec(network);
  if (match) {
    const bare = CHAIN_ID_TO_EVM_NETWORK[Number(match[1])];
    if (bare) return bare;
  }
  throw new Error(
    `Cannot emit x402 V1 for network "${network}": no known bare-name equivalent. ` +
      'V1 wire requires a bare network name (e.g. "base-sepolia").',
  );
}

/**
 * True when two network ids refer to the same chain, regardless of whether
 * each is expressed as a bare name or CAIP-2. Used for cross-generation
 * requirement selection and budget matching.
 */
export function sameNetwork(a: string, b: string): boolean {
  if (a === b) return true;
  return toCaip2(a) === toCaip2(b);
}
