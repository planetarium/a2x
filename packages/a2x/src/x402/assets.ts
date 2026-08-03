/**
 * Per-asset EIP-712 domain defaults for the `exact` scheme's `extra`.
 *
 * `@x402/evm` builds the EIP-3009 signing domain from the requirement's
 * `extra.name` / `extra.version` (it does NOT read them on-chain), so an
 * agent that omits `extra` relies on the SDK's default — and a wrong default
 * produces a signature under the wrong EIP-712 domain that the facilitator
 * cannot verify.
 *
 * USDC's domain name differs by deployment (`"USD Coin"` on Base mainnet,
 * `"USDC"` on Base Sepolia), so a single hard-coded default cannot be right
 * everywhere. This table pins the well-known USDC deployments a2x documents;
 * anything else falls back to the historical `{ name: 'USDC', version: '2' }`
 * default — callers using a different token MUST supply their own `extra`.
 */

import type { X402Accept } from './types.js';

export interface X402Eip712Extra {
  name: string;
  version: string;
  [key: string]: unknown;
}

/** Historical fallback — correct for Base Sepolia USDC, overridable via `extra`. */
const FALLBACK_EXTRA: X402Eip712Extra = { name: 'USDC', version: '2' };

/** Known token contract (lowercased) → EIP-712 domain `{ name, version }`. */
const KNOWN_ASSET_EIP712: Record<string, X402Eip712Extra> = {
  // USDC on Base mainnet (FiatTokenV2_2) — EIP-712 name is "USD Coin".
  '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913': { name: 'USD Coin', version: '2' },
  // USDC on Base Sepolia (Circle testnet deployment) — EIP-712 name is "USDC".
  '0x036cbd53842c5426634e7929541ec2318f3dcf7e': { name: 'USDC', version: '2' },
};

/**
 * Default `extra` (EIP-712 `name`/`version`) for a given asset when the agent
 * didn't supply one. Returns a fresh object so callers can mutate it freely.
 */
export function defaultEip712Extra(asset: string): X402Eip712Extra {
  return { ...(KNOWN_ASSET_EIP712[asset.toLowerCase()] ?? FALLBACK_EXTRA) };
}

/**
 * The `extra` key (or its absence) for an encoded requirement.
 *
 * `extra` is scheme-specific and the EIP-712 domain default above only means
 * something to `exact`/EIP-3009. Other schemes put unrelated data there —
 * `upto` carries the `facilitatorAddress` the payer's Permit2 witness binds
 * to — so synthesizing a signing domain for them would emit a field the
 * client cannot interpret (and, worse, would look like a valid `extra` to a
 * scheme that requires a real one). A caller-supplied `extra` always wins;
 * otherwise the default applies to `exact` only and the key is omitted.
 */
export function schemeExtra(
  scheme: string,
  accept: X402Accept,
): { extra?: Record<string, unknown> } {
  if (accept.extra) return { extra: accept.extra };
  return scheme === 'exact' ? { extra: defaultEip712Extra(accept.asset) } : {};
}
