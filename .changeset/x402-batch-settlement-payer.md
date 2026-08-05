---
'@a2x/sdk': minor
---

Native payer support for the x402 V2 `batch-settlement` scheme.

`batch-settlement` pays out of a pre-funded on-chain channel: the payer
deposits once, then each call carries only an off-chain cumulative voucher,
and the merchant redeems many of them in a single transaction out of band.
That takes settlement off the response critical path and amortizes gas across
calls — the difference between viable and not when a metered call prices below
a cent.

- `A2XClientX402Options.batchSettlement` / `SignX402PaymentOptions.batchSettlement`
  register `@x402/evm`'s batch client scheme. Supplying the object **is** the
  opt-in: unlike `exact` and `upto` the scheme cannot be built from a signer
  alone, so it stays unregistered without one.
- `storage` is required, with deliberately no in-memory default. a2x signs with
  a viem `LocalAccount`, which has no `readContract`, so `@x402/evm`'s on-chain
  channel recovery never runs and this storage is the only record a channel
  exists — losing it makes the next call sign a **fresh deposit** into an
  already-funded channel. New `X402ClientChannelStorage` / `X402ChannelState`
  types describe the contract without importing the optional peer.
- `reconcileX402BatchSettlement(receipts, { storage })` folds settlement
  receipts back into channel storage. Required because a2x carries payments
  over A2A task metadata and never runs `@x402/evm`'s `onPaymentResponse`
  hook, which is what normally advances the payer's cumulative amount.
  `A2XClient` calls it automatically on both the blocking and streaming paths.
- Selection stays opt-in behind `allowBatchSettlement`, separate from
  `allowUpto`: `upto` widens how much of an authorization a merchant may draw,
  while funding a channel moves money before any service is rendered. Default
  preference is `exact` → `upto` → `batch-settlement`, widest consent last.
  V2-only and CAIP-2-only, like `upto`.
- Deposit sizing is tunable via `depositPolicy` (default 5x the request
  amount) or `depositStrategy` for full per-deposit control.

`A2XClient`'s `maxAmount` now bounds the **deposit** for a `batch-settlement`
offer, not just the request amount — paying one call there authorizes
`depositMultiplier x` the price (5x by default), so a cap that only bounded
the per-call amount would let a wallet capped at 1 USDC authorize 5. Offers
whose deposit exceeds the cap are filtered out. A caller-supplied
`depositStrategy` sizes deposits itself and is left alone.

Merchant-side wiring is documented rather than shipped: voucher accounting
needs `@x402/core`'s server lifecycle, and redemption must be a singleton
across replicas, so the guide shows injecting an `x402ResourceServer` as
`X402Context`'s facilitator instead.
