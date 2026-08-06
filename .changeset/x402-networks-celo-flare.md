---
'@a2x/sdk': minor
---

Add `celo` (42220) and `flare` (14) to the x402 EVM network table, and raise
the `@x402/core` / `@x402/evm` peer floor to `>=2.20.0 <3`.

`@x402/evm` 2.20 added both to `EVM_NETWORK_CHAIN_ID_MAP`, and a2x's mirror of
that table had fallen behind. Since the old peer range (`>=2.19.0 <3`) admits
those minors — and a fresh install resolves to one — the gap affected anyone
on a current peer:

- `isEvmNetwork('celo')` returned `false`, so the default selector skipped
  Celo and Flare `exact` offers outright. A merchant advertising only those
  rails surfaced `X402NoSupportedRequirementError` even though the signer
  could have paid.
- `toBareName('eip155:42220')` threw, so a V1 requirement on either chain
  could not be emitted at all.

The drift guard in `x402-networks-drift.test.ts` compares the table against
the peer's map; it was passing only because workspace consumers were pinned to
2.19. The SDK, CLI bundle, and x402 samples now use `~2.21.0`, so local and CI
builds no longer exercise a peer version outside the SDK's declared range.

The peer floor moves to 2.20.0 because the fix makes the table depend on it.
Under 2.19 a2x would now recognize `celo` as an EVM network the signer can
fulfil, select such an offer ahead of a payable one later in `accepts[]`, and
then fail inside `@x402/evm` — which registers V1 schemes only for networks in
its own map. That would turn a payment that used to succeed into a failure, so
2.19 is no longer claimed as supported rather than left silently broken.
Nothing else in the SDK required the bump: the `batch-settlement` client is
byte-identical between 2.19 and 2.21.
