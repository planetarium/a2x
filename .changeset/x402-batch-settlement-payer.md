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
- The reconciliation write is a deterministic fold —
  `trusted pre-attempt snapshot + binding + receipt → next state` — computed
  from the channel snapshot captured when the payload was signed, never from
  whatever the storage holds when the fold runs. Retries are therefore exact:
  re-running the same binding and receipt rewrites the same state, which
  repairs a torn write (cumulative committed without the balance, or the
  reverse) for deposits and voucher-only payments alike, instead of guessing
  from the half-committed record. Attempts are ordered by identity, not by
  the cumulative — a metered call may charge zero, so two attempts can share
  a cumulative while the newer one moved real funds. Each binding carries an
  `attemptId` and each fold stamps it as `lastAppliedAttemptId` on the
  record: a fold rewrites only a record it stamped or one still descending
  from its own snapshot, so a replayed older receipt cannot roll back a
  newer attempt's balance at an equal cumulative. Reconciliation also
  rejects duplicate same-channel bindings, serializes each channel for
  callers sharing one storage object in a process, and ignores late receipts
  instead of letting a delayed read-check-write roll cumulative state back.
  Backends shared across processes still require one writer per channel
  because the upstream storage contract has no atomic compare-and-set.
- `A2XClient` also serializes the complete sign, submit, and
  reconcile/quarantine lifetime for batch attempts sharing one storage object.
  The peer does not reserve state while signing, so without that lease two
  concurrent calls can read the same empty channel and each authorize a fresh
  deposit. If the active attempt is quarantined, callers already queued behind
  it are rejected before signing from the stale snapshot. Manual and
  cross-process flows must provide equivalent per-channel exclusion or a
  durable reservation themselves.
- `bindings` ties the fold to what that exchange actually signed — the channel,
  the cumulative ceiling its voucher authorized, the deposit it funded, and
  the pre-attempt snapshot (`preAttemptState`, a required key whose
  fresh-channel value is the JSON-safe `null`, so persisted bindings survive
  a `JSON.stringify` round trip). Each closes a
  distinct path. Channel ids derive from public inputs, so without the first a
  merchant could name a channel belonging to a *different* merchant and
  overwrite its cumulative. Without the second, the same merchant can inflate
  its own: reporting 5000 after a 1000 voucher makes the payer's next call
  sign a 6000 cumulative plus a top-up, letting it claim far more than the
  calls cost. Without the third and fourth, a merchant reporting
  `balance: "0"` every round induces a fresh deposit every round — each within
  `maxAmount`, which caps deposits individually rather than in aggregate; a
  balance below `snapshot balance + this deposit` is replaced by that floor,
  which is derived from the payer's own trusted state rather than from the
  merchant. A receipt with no cumulative at all is refused too, since it would
  write partially and leave the signing base unmoved. `signX402Payment`
  assembles the complete binding as `SignedX402Payment.batch`; the new
  `getX402BatchSettlementBinding()` reads the payload-provable half off a
  persisted payload for resumption.
- Successful reconciliation validates the receipt cumulative against the
  attempt's trusted bounds, never above the voucher's signed ceiling. A
  metered receipt — carrying `extra.chargedAmount`, produced when the server
  settles via `X402Context.settle({ amountAtomic })` — must report exactly
  `pre-attempt cumulative + chargedAmount`, and the fold commits that
  reported figure. An unmetered receipt must report the signed ceiling
  exactly, since the plain lifecycle advances by the full offered amount;
  accepting a lower one there would let a stale historical receipt mask the
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
- A submitted attempt survives a crash. Immediately before the signed
  payload is handed to `fetch`, the client awaits a durable
  `pendingAttempt` record — attempt id, repair binding, task id — on the
  channel (a failed write aborts before anything is sent). A process that
  dies mid-flight therefore leaves the record behind, and a restarted payer
  signing against the channel gets the new `X402AttemptPendingError`
  instead of authorizing a second deposit while the merchant may hold the
  first. The record clears when the owning attempt's receipt folds, its
  rejection is proven by a valid retry prompt, or its quarantine marker
  supersedes it.
- Deletion erases the generation: replay protection lives in the stored
  record, so an unversioned `delete` (the peer's cooperative refund does
  this when a channel drains) makes absence indistinguishable from a
  never-opened channel, and a stale receipt can resurrect it. Documented on
  the storage contract: the supported retirement is rotating `salt` and
  never reusing the old channel; a retained record is safe only in the
  documented retirement shape (a `retired:` generation no attempt owns plus
  a quarantine marker), since keeping the old attempt stamp leaves the old
  receipt able to rewrite the record. A first-class tombstone helper is
  planned with the transactional storage extension.
- Quarantine survives a restart, and carries its repair inputs.
  `X402ReconciliationError` retains the attempt's complete binding
  (pre-attempt snapshot included) and the paid task's id — on a transport or
  stream failure that id is the caller's only handle for fetching the
  settled receipt, since the client consumed the `payment-required` task
  internally. Alongside the raised error, the SDK best-effort persists
  `quarantinedAt` / `quarantineReason` plus the same recovery record
  (`quarantineBinding` / `quarantineTaskId`) onto the channel's stored
  record; while the marker is present, signing against the channel throws
  the new `X402ChannelQuarantinedError` before the payload reaches the
  merchant. The owning attempt's successful reconciliation fold — the repair
  path — clears the marker; a fold by any other attempt preserves it, since
  the merchant may still hold the quarantined attempt's spendable voucher.
  Remove it manually only after verifying the stored state.
- A matching success receipt suppresses contradictory retry prompts anywhere
  later in the same response stream, including a separate SSE event, so one
  call cannot make the payer authorize two cumulative vouchers.
- Selection stays opt-in behind `allowBatchSettlement`, separate from
  `allowUpto`: `upto` widens how much of an authorization a merchant may draw,
  while funding a channel moves money before any service is rendered. Default
  preference is `exact` → `upto` → `batch-settlement`, widest consent last.
  V2-only and CAIP-2-only, like `upto`.
- Deposit sizing is tunable via `depositPolicy` (default 5x the request
  amount) or `depositStrategy` for full per-deposit control.
- The batch signing runtime is constructed only when that scheme wins
  selection and is rebuilt from a per-attempt options snapshot. That same
  snapshot's storage is carried through reconciliation, so invalid or mutated
  batch configuration cannot poison an `exact` payment or make an in-flight
  attempt sign against one storage object and write its receipt to another.

On the merchant side, scheme-scoped payer extraction reads
`batch-settlement` identity from the voucher-bound `channelConfig.payer`.
Unrelated authorization-shaped keys cannot spoof receipt or audit attribution.

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
