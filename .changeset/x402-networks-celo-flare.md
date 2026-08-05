---
'@a2x/sdk': patch
---

Add `celo` (42220) and `flare` (14) to the x402 EVM network table.

`@x402/evm` 2.20 added both to `EVM_NETWORK_CHAIN_ID_MAP`, and a2x's mirror of
that table had fallen behind. Since the declared peer range (`>=2.19.0 <3`)
admits those minors — and a fresh install resolves to one — the gap affected
anyone on a current peer:

- `isEvmNetwork('celo')` returned `false`, so the default selector skipped
  Celo and Flare `exact` offers outright. A merchant advertising only those
  rails surfaced `X402NoSupportedRequirementError` even though the signer
  could have paid.
- `toBareName('eip155:42220')` threw, so a V1 requirement on either chain
  could not be emitted at all.

The drift guard in `x402-networks-drift.test.ts` compares the table against
the peer's map; it was passing only because the dev dependency was pinned to
2.19. That pin is now `~2.21.0`, so CI exercises the same peer version a fresh
install resolves to.
