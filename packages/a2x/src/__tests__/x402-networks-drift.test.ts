/**
 * Guards the network table in `x402/networks.ts` against drift from
 * `@x402/evm`'s `EVM_NETWORK_CHAIN_ID_MAP`, which the table mirrors. The
 * peer range (`>=2.20.0 <3`) admits future minors that may add networks;
 * if the local table falls behind, `isEvmNetwork` stops selecting
 * requirements the signer could actually fulfil, and `toCaip2` /
 * `toBareName` stop round-tripping the new name. The table is module-
 * private by design, so the comparison runs through the public helpers.
 */
import { describe, expect, it } from 'vitest';
import { EVM_NETWORK_CHAIN_ID_MAP } from '@x402/evm/v1';
import { isEvmNetwork, toBareName, toCaip2 } from '../x402/networks.js';

describe('x402 network table — drift against @x402/evm', () => {
  const entries = Object.entries(EVM_NETWORK_CHAIN_ID_MAP) as [string, number][];

  it('mirrors every bare name @x402/evm supports', () => {
    for (const [name, chainId] of entries) {
      expect(isEvmNetwork(name), `isEvmNetwork(${name})`).toBe(true);
      expect(toCaip2(name), `toCaip2(${name})`).toBe(`eip155:${chainId}`);
    }
  });

  it('maps every @x402/evm chain id back to its bare name', () => {
    for (const [name, chainId] of entries) {
      expect(toBareName(`eip155:${chainId}`), `toBareName(eip155:${chainId})`).toBe(name);
    }
  });
});
