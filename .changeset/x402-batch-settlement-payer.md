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
- `storage` is required, with deliberately no in-memory default. The runtime
  rejects an absent or malformed storage object before upstream can silently
  select its in-memory fallback. a2x signs with
  a viem `LocalAccount`, which has no `readContract`, so `@x402/evm`'s on-chain
  channel recovery never runs and this storage is the only record a channel
  exists — losing it makes the next call sign a **fresh deposit** into an
  already-funded channel. New `X402ClientChannelStorage` / `X402ChannelState`
  types describe the contract without importing the optional peer.
- `reconcileX402BatchSettlement(receipts, { storage, bindings })` folds
  settlement receipts back into channel storage. Required because a2x carries
  payments over A2A task metadata and never runs `@x402/evm`'s
  `onPaymentResponse` hook, which is what normally advances the payer's
  cumulative amount. `A2XClient` calls it automatically on both the blocking
  and streaming paths.
- `bindings` ties the fold to what that exchange actually signed — the channel,
  the cumulative ceiling its voucher authorized, and the deposit it funded.
  Each closes a distinct path. Channel ids derive from public inputs, so
  without the first a merchant could name a channel belonging to a *different*
  merchant and overwrite its cumulative. Without the second, the same merchant
  can inflate its own: reporting 5000 after a 1000 voucher makes the payer's
  next call sign a 6000 cumulative plus a top-up, letting it claim far more
  than the calls cost. Without the third, a merchant reporting `balance: "0"`
  every round induces a fresh deposit every round — each within `maxAmount`,
  which caps deposits individually rather than in aggregate; a balance below
  `stored + this deposit` is replaced by that floor, which is derived from the
  payer's own durable state rather than from the merchant. A receipt with no
  cumulative at all is refused too, since it would write partially and leave
  the signing base unmoved. Read the binding off a signed payload with the new
  `getX402BatchSettlementBinding()`.
- Successful reconciliation requires the receipt cumulative to equal the
  voucher's signed ceiling. Upstream verify and settle establish that exact
  value; accepting a lower one would let a stale historical receipt mask the
  current exchange while the merchant retains the higher-value voucher.
- A receipt that cannot be recorded — a storage failure, a terminal task with
  no usable receipt, a non-terminal unary return, or a transport/parser/SSE
  exit (including consumer-driven iterator close) after submission — raises
  the new `X402ReconciliationError`, carrying the channel id, the merchant's
  task when available, and a `reason` (`write-failed` /
  `no-matching-receipt` / `ambiguous-response`). Failing loudly
  is deliberate: a lost receipt leaves the channel desynced with no self-heal
  path (`@x402/evm`'s corrective recovery needs a chain-reading signer, which a
  `LocalAccount` is not), so the next call is rejected for a cumulative
  mismatch or opens a fresh on-chain deposit. Set
  `A2XClientX402Options.onReconcileError` to record and continue instead.
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
the per-call amount would let a wallet capped at 1 USDC authorize 5. The
request amount is filtered before selection, then any deposit actually needed
after reading channel storage — including one a `depositStrategy` returned —
is checked before signing. A funded channel can therefore keep paying with
voucher-only payloads under the cap without being rejected by its original
deposit estimate.

Every terminal A2A task after a batch voucher was submitted also requires a
matching receipt even when the merchant omits `x402.payment.status`. The same
channel is surfaced for quarantine if the blocking response fails or a
follow-up SSE stream errors, is aborted, or reaches EOF before a receipt or
complete retry prompt. A status marker without `x402.payment.required` is
ambiguous and cannot clear the outstanding binding. Conversely, when a
response carries both a matching success receipt and a retry prompt, the
receipt wins and the client does not sign the same call again. Together these
rules prevent the remote peer from retaining a voucher while silently leaving
the payer's channel state stale or inducing a duplicate payment.

Merchant-side wiring is documented rather than shipped: `X402Context` now
recognizes the ordinary deposit and voucher payload shapes, while voucher
accounting needs `@x402/core`'s server lifecycle, and redemption must be a
singleton across replicas, so the guide shows injecting an `x402ResourceServer` as
`X402Context`'s facilitator instead. V1 offering encoding rejects the V2-only
scheme before persisting an unusable payment challenge.
