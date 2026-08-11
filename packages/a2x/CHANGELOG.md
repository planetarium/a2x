# @a2x/sdk

## 0.20.0

### Minor Changes

- [#207](https://github.com/planetarium/a2x/pull/207) [`9207118`](https://github.com/planetarium/a2x/commit/920711846af8806a2bcb94d3c1242870e7854aaa) Thanks [@longfin](https://github.com/longfin)! - Add an optional host-neutral merchant-policy composition to `@a2x/sdk/x402`, with configurable exact, `upto`, and `batch-settlement` pricing, frozen offer terms, metering, retry-safe execution claims, resource-server lifecycle integration, refund bypass, and batch recovery receipts.

- [#213](https://github.com/planetarium/a2x/pull/213) [`667ce37`](https://github.com/planetarium/a2x/commit/667ce370a9e767ff6496c943aaf0097b0b902054) Thanks [@longfin](https://github.com/longfin)! - Add opt-in conversation-scoped `upto` metering with CAS-backed turn leases, idle/deadline/budget settlement triggers, zero-usage lapse handling, and restart-safe reconciliation records.

### Patch Changes

- [#214](https://github.com/planetarium/a2x/pull/214) [`d4ad3a5`](https://github.com/planetarium/a2x/commit/d4ad3a5545efb7bf3854ec79e63ce028f3495c64) Thanks [@longfin](https://github.com/longfin)! - Make `MerchantGate` replay handling lifecycle-aware, retain completed receipts until expiry, skip verification for known claimed attempts, and keep indeterminate settlement attempts claimed for reconciliation.

## 0.19.0

### Minor Changes

- [#204](https://github.com/planetarium/a2x/pull/204) [`268c4f2`](https://github.com/planetarium/a2x/commit/268c4f257bfb74eb82faa504cdd0ca5102347a5c) Thanks [@longfin](https://github.com/longfin)! - Native payer support for the x402 V2 `batch-settlement` scheme.

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
    merchant could name a channel belonging to a _different_ merchant and
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

- [#204](https://github.com/planetarium/a2x/pull/204) [`52d2f3f`](https://github.com/planetarium/a2x/commit/52d2f3fe5324d9bb8cdbe4b189c12f6359fb047c) Thanks [@longfin](https://github.com/longfin)! - Add `celo` (42220) and `flare` (14) to the x402 EVM network table, and raise
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

- [#204](https://github.com/planetarium/a2x/pull/204) [`268c4f2`](https://github.com/planetarium/a2x/commit/268c4f257bfb74eb82faa504cdd0ca5102347a5c) Thanks [@longfin](https://github.com/longfin)! - `X402SettleResponse` now carries the facilitator's scheme-specific `extra`.

  `BaseX402Context.settle()` built the wire receipt from a fixed field list and
  dropped everything else the facilitator returned. That is lossy for any
  stateful scheme: `batch-settlement` reports the channel's post-settlement
  state in `extra.channelState`, and it is the payer's only way to learn its
  voucher was accepted and what the next one must be cumulative over. Without it
  a payer re-signs an identical voucher — and re-deposits — on every call.

  The block is forwarded verbatim and retained in the durable lifecycle-store
  receipt (plain objects only; a scalar or array from a remote facilitator is
  dropped rather than typed as a record). Retaining it lets a stateful server
  recover after settlement even if it stops before emitting the terminal A2A
  event. `exact` and `upto` never populate it, so existing receipts are unchanged.

  For a `batch-settlement` receipt, `X402SettleResponse.amount` now reports the
  per-call service charge from `extra.chargedAmount`. Upstream's top-level
  `amount` names the immediate transfer — empty for an off-chain voucher, the
  whole funding total for a deposit payload — so passing it through verbatim
  would record either nothing or the deposit as "what this call settled for".
  Other schemes keep the facilitator's `amount` unchanged.

  Also corrects the documented meaning of `transaction`. It reads "Transaction
  hash on success, empty string on failure", but a successful `batch-settlement`
  voucher settles off-chain and upstream returns `{ success: true, transaction:
'' }`. An empty `transaction` therefore does not imply failure — branch on
  `success`.

## 0.18.0

### Minor Changes

- [#202](https://github.com/planetarium/a2x/pull/202) [`ccea931`](https://github.com/planetarium/a2x/commit/ccea931b7ea936b1d1f990172370c865319e9bb6) Thanks [@longfin](https://github.com/longfin)! - Native support for the x402 V2 `upto` scheme (usage-based payments), where the payer signs a Permit2 authorization **up to** a maximum and the merchant settles only the metered charge — bill by LLM token consumption instead of a flat per-call fee. ([#199](https://github.com/planetarium/a2x/issues/199))

  - `X402Accept.scheme` now types `'exact' | 'upto' | (string & {})` instead of pinning `'exact'`.
  - `validateX402PayloadShape` dispatches on the payload shape the matched requirement implies. Permit2 requirements (`upto`, and `exact` whose `extra` sets `assetTransferMethod: 'permit2'` — which `@x402/evm` uses for several of its built-in stablecoins) are validated as Permit2: `permit2Authorization` + `signature` present, `witness.to` bound to `payTo`, `permitted.token` matching the asset, a positive in-range `permitted.amount`, and a payer `from`. Everything else keeps the EIP-3009 checks. Unrecognized payloads no longer report the misleading "Non-EVM payloads are not yet supported" — a Permit2 payload is an EVM payload.
  - `BaseX402Context.settle(ctx, classified, { amountAtomic })` settles a metered amount. The SDK clamps it down to the minimum of the metered value, the offered amount, and the payer's signed authorization cap, using BigInt comparison — a merchant metering bug can therefore only ever undercharge. `"0"` is a legal charge. `amountAtomic` must be a plain decimal integer string: bare `BigInt` would read `''` as zero and `'0x10'` as sixteen, so anything else throws. Metering an `exact` requirement also throws, since that scheme binds the signature to a single value and facilitators reject a mismatched settle — the SDK fails on the call rather than after the work is done.
  - Shape validation moved behind a `protected validatePayloadShape(payload, requirement)` hook on `BaseX402Context`, called by `classify` **before** the store records `status: 'failed'`, so a subclass teaching the pipeline a new scheme no longer has to repair the store afterwards.
  - `payer` is now resolved from the field the matched requirement's scheme actually signs, rather than sniffed from whichever key the payload carries. A payload presenting both an EIP-3009 `authorization` and a Permit2 `permit2Authorization` could otherwise let the decoy name the payer on the receipt and in the audit store. `parseX402PaymentSubmission` exposes `payer` and `permit2Authorization`; the new `extractX402Payer(payload, scheme?)` applies the same dispatch for callers driving the pipeline themselves.
  - `X402EntryReceipt` gains an optional `amount` — the settled charge, persisted on the store entry. It records only what the **facilitator confirmed**; when the facilitator reports no amount the key is absent rather than backfilled from what the SDK asked to settle. Under a usage-based scheme it is the key reconciliation datum and is not recoverable from `entry.accepts`, which holds the authorized maximum.
  - The wire codecs no longer synthesize an EIP-712 domain into `extra` for non-`exact` schemes. That default is `exact`/EIP-3009-specific, and emitting it would have shadowed the `facilitatorAddress` an `upto` requirement must carry.
  - New exported types: `X402Permit2Authorization`, `X402UptoEvmPayload`, `X402ExactEvmPayload`.

  `upto` is **x402 V2 only** and the SDK enforces it: encoding an `upto` offering under `x402Version: 1` throws a configuration error from `requestPayment` before anything is persisted, and the client selector never picks a bare-name (V1) upto offer. Neither `@x402/core`'s client nor the reference facilitator has a V1 path for the scheme, so a V1 offering could only dead-end mid-payment.

  Client signing registers `@x402/evm`'s `UptoEvmScheme` alongside the exact scheme, so an `upto` offer can be signed. **The default selector still never auto-picks one** — signing `upto` authorizes spending up to the maximum at the merchant's discretion, a broader consent than `exact`, so it stays opt-in via the new `allowUpto` option on `SignX402PaymentOptions` and `A2XClient`'s `x402` config (a payable CAIP-2 `exact` offer always wins), or via an explicit `selectRequirement`.

  **Subclassers:** an override of `BaseX402Context.settle` written against the old two-argument signature silently drops `amountAtomic` and settles the full offered ceiling. Accept the third `opts` parameter and forward it to `super.settle(...)`.

  `upto` requires `@x402/evm` >= 2.19, which the existing peer range (`>=2.19.0 <3`) already mandates — no peer-range change.

- [#200](https://github.com/planetarium/a2x/pull/200) [`33c4f56`](https://github.com/planetarium/a2x/commit/33c4f5606ff3ef6f3c83058867bee1b64ce6af9c) Thanks [@longfin](https://github.com/longfin)! - x402 V2 `payment-required` envelopes can now carry the top-level `extensions` field. `X402RequestPaymentInput` (and therefore `x402RequestPayment`, `buildX402PaymentRequiredMetadata`, and `X402Context.requestPayment`) accepts an `extensions` object that `encodePaymentRequiredV2` emits verbatim; it is a no-op under `x402Version: 1`, whose envelope has no such field. This is how a merchant advertises facilitator capabilities such as `eip2612GasSponsoring` — without it, `@x402/evm` payers fall back to a gas-paying on-chain approval even when the facilitator would sponsor a gasless permit. The new client-side reader `getX402PaymentExtensions(task)` returns the advertised object so callers driving signing manually can hand it to `@x402/core`'s `PaymentPayloadContext`. ([#197](https://github.com/planetarium/a2x/issues/197))

### Patch Changes

- [#200](https://github.com/planetarium/a2x/pull/200) [`33c4f56`](https://github.com/planetarium/a2x/commit/33c4f5606ff3ef6f3c83058867bee1b64ce6af9c) Thanks [@longfin](https://github.com/longfin)! - Preserve the facilitator's settled `amount` on x402 settlement receipts.

  `X402Context.settle()` trimmed the facilitator response into the wire receipt and dropped the x402 V2 `amount` field, so the settled amount never reached `x402.payment.receipts` on the task's final message. `X402SettleResponse` now carries an optional `amount`, and `settle()` passes the facilitator's value through on the success receipt and on failure receipts built from a structured `success: false` response body. (Non-2xx settlement failures surface as errors thrown by `@x402/core`, which drops `amount` before the SDK sees it — those failure receipts cannot carry the field.) For the `exact` scheme this matches the offered amount; under usage-based schemes it is the metered charge and is the payer's only record of what they were actually charged. V1 facilitators never report it, so the field stays absent there.

## 0.17.0

### Minor Changes

- [#194](https://github.com/planetarium/a2x/pull/194) [`9413a55`](https://github.com/planetarium/a2x/commit/9413a55baf7c16d0fd85779b85545059fb1ac836) Thanks [@longfin](https://github.com/longfin)! - Servers now read the A2A v1.0 `A2A-Version` header (spec a2a-v1.0 §3.2.6 / §9.2). The pinned version is matched on `Major.Minor` per spec (`0.3.0` pins the same version as `0.3`); a pin that doesn't match the server's `protocolVersion` is rejected with the new `VersionNotSupportedError` (`-32009`, exported and added to `A2A_ERROR_CODES` as `VERSION_NOT_SUPPORTED`). Requests without the header keep being served in the server's configured version. ([#193](https://github.com/planetarium/a2x/issues/193))

- [#194](https://github.com/planetarium/a2x/pull/194) [`9413a55`](https://github.com/planetarium/a2x/commit/9413a55baf7c16d0fd85779b85545059fb1ac836) Thanks [@longfin](https://github.com/longfin)! - `protocolVersion: '1.0'` servers now accept the A2A v1.0 JSON-RPC method names (`SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, `SubscribeToTask`, `CreateTaskPushNotificationConfig`, `GetTaskPushNotificationConfig`, `ListTaskPushNotificationConfigs`, `DeleteTaskPushNotificationConfig`, `GetExtendedAgentCard`) per spec a2a-v1.0 §9.4, and normalize the v1.0 `ROLE_USER` / `ROLE_AGENT` message roles on inbound messages. v0.3 method spellings remain accepted on v1.0 servers as a legacy-compat extension; `protocolVersion: '0.3'` servers are unchanged and keep rejecting v1.0 spellings. The v1.0 method table is exported as `A2A_METHODS_V10`. ([#193](https://github.com/planetarium/a2x/issues/193))

### Patch Changes

- [#194](https://github.com/planetarium/a2x/pull/194) [`9413a55`](https://github.com/planetarium/a2x/commit/9413a55baf7c16d0fd85779b85545059fb1ac836) Thanks [@longfin](https://github.com/longfin)! - Servers now accept the A2A v1.0 `A2A-Extensions` extension-activation header (spec a2a-v1.0 §3.2.6) in addition to the v0.3-era `X-A2A-Extensions` spelling. Previously a strictly conformant v1.0 client activating a required extension via `A2A-Extensions` was rejected with `-32600`. The required-extension rejection message now names the header matching the server's `protocolVersion`. ([#193](https://github.com/planetarium/a2x/issues/193))

## 0.16.0

### Minor Changes

- [#179](https://github.com/planetarium/a2x/pull/179) [`7a4a29e`](https://github.com/planetarium/a2x/commit/7a4a29e32093c676cd71191de690f724fd732d62) Thanks [@longfin](https://github.com/longfin)! - Expose the client's activated A2A extensions to agents via `InvocationContext.activatedExtensions`.

  The extension URIs a client sends in the `X-A2A-Extensions` header are now threaded from the request handler through the executor and runner onto `InvocationContext.activatedExtensions`, so agents can branch on what the client activated. `AgentExecutor.execute` / `executeStream` accept an optional `{ activatedExtensions }` argument to carry it. All additions are optional and backward-compatible. The x402 extension uses this for its compatibility check: an x402 V2 server refuses a client whose activation declares it V1-only.

- [#179](https://github.com/planetarium/a2x/pull/179) [`7a4a29e`](https://github.com/planetarium/a2x/commit/7a4a29e32093c676cd71191de690f724fd732d62) Thanks [@longfin](https://github.com/longfin)! - x402: support both protocol versions (V1 and V2), one per deployment.

  A2X now implements the x402 Foundation A2A transport (V2 — CAIP-2 networks, `amount`, hoisted top-level `resource`, and a `PaymentPayload` that echoes the chosen requirement under `accepted`) alongside the existing V1 envelopes. A server speaks exactly **one** version, configured with `X402ContextOptions.x402Version` (**V1** by default — the version the upstream `x402_a2a` reference lineage decodes; opt into V2 with `new X402Context({ x402Version: 2 })` and advertise the foundation URI). There is no per-request version negotiation, because the activation channel cannot express one: the foundation extension URI is version-neutral (its V1 and V2 transport docs declare the same URI) and no URI means "send me V2". Clients sign whichever version they receive.

  The one version signal the activation channel does carry is the legacy v0.2 URI, whose defining spec pairs it exclusively with V1 wire structures: activating it declares a V1-only client. A V1 server serves it; an `x402Version: 2` server refuses it at `requestPayment` with a `payment-failed` / `invalid_x402_version` event (in version-neutral metadata) instead of emitting envelopes the client cannot decode — per A2A's extension rules, an agent must not silently fall back to a different version. Advertising `X402_FOUNDATION_EXTENSION_URI` while accepting `X402_EXTENSION_URI` activations is handled by an activation family in the request handler (an a2x-server-specific relaxation of A2A's `required` rule), so legacy v0.2 clients still pass a V1 agent's `required` check.

  New exports from `@a2x/sdk/x402`: `X402_FOUNDATION_EXTENSION_URI`, `X402_EXTENSION_URIS`, `X402_SUPPORTED_VERSIONS`, `X402_DEFAULT_VERSION`, `detectX402Version`, `isSupportedVersion`, `isX402ExtensionUri`, `X402PeerMissingError`, and the V1/V2 requirement/payload/response type variants. `X402ContextOptions` gains `x402Version`; `X402StoreEntry` gains `offeredX402Version`.

  Three behavior changes worth knowing about when upgrading:

  - **Server-side validation now enforces `x402Version` on submitted payloads**, per x402-v1 §5.2 ("All fields are required"; `x402Version` is a `number` that "must be 1"). Previously a submission was matched on `scheme`/`network` alone and the version was never inspected, so a non-conformant client that omitted the field — or sent it as the string `"1"` — was accepted. Such submissions now fail with `invalid_x402_version`. Payloads produced by the `x402` package, `@x402/core`, or a2x itself always carry the numeric field and are unaffected; only hand-rolled or third-party clients that skipped it are.
  - `resolveFacilitator` no longer throws when the facilitator rejects a payment. `@x402/core` raises `VerifyError`/`SettleError` on a non-2xx response even when the body is a usable `{isValid:false}` / `{success:false}`; the SDK now unwraps that back into a normal negative result. Agents that wrapped `facilitator.verify()` in `try`/`catch` to detect failures should branch on `isValid` / `success` instead — their catch block will no longer fire. Genuine transport/schema errors still propagate.
  - `A2XClient` may stop sending the legacy v0.2 URI in `X-A2A-Extensions`. When the resolved AgentCard advertises `X402_FOUNDATION_EXTENSION_URI`, the client upgrades to it and drops the v0.2 URI it auto-seeded. A URI the caller registered explicitly is never dropped: `extensions: [X402_EXTENSION_URI]` is the documented "this client decodes V1 only" declaration, and it goes out alone so the declaration stays legible to any peer.

  Fixes a client-side budget-cap bug: `maxAmount` enforcement read the V1-only `maxAmountRequired` field, which is absent on V2 requirements — the cap is now read through a version-agnostic accessor.

  **Breaking (peer dependencies + types).** The signing/facilitator runtime moved from `x402` to `@x402/core` + `@x402/evm` (both optional peers). Install `@x402/core @x402/evm viem` instead of `x402 viem` when enabling x402. Because the peers load lazily, forgetting this is not caught at install or startup — it surfaces on the first real payment as `X402PeerMissingError`, which names the packages to install (the failed load isn't cached, so the next attempt succeeds once they are).

  The `X402PaymentRequirements` type is now a V1|V2 union, so code reading requirement fields directly should use the exported accessors (`requirementAmount`, `requirementNetwork`, `requirementScheme`, `requirementPayTo`) or narrow on `x402Version`. `X402SettleResponse.payer` is now optional (x402 V2 marks it optional and the SDK never fabricates a placeholder), and `X402PaymentRequiredResponse.x402Version` widened from the literal `1` to `1 | 2`. `X402Accept` — the type agents author their offerings with — is unchanged, so agents that define offerings and drive `X402Context` need no code change.

  Per AGENTS.md semver ("pre-1.0, still follow semver"), this breaking change ships as a `minor` because the package is pre-1.0 (0.x) — 0.x minors may carry breaking changes.

### Patch Changes

- [#179](https://github.com/planetarium/a2x/pull/179) [`4d6ed7c`](https://github.com/planetarium/a2x/commit/4d6ed7cd3cff8c5aa55a2244a1d4c7e73b44a531) Thanks [@longfin](https://github.com/longfin)! - x402: default the EIP-712 `extra` domain per asset instead of always `{name:'USDC'}`.

  `@x402/evm` builds the EIP-3009 signing domain from the requirement's `extra.name`/`extra.version`, so an offering that omits `extra` relied on the SDK default — which was hard-coded to `{ name: 'USDC', version: '2' }`, correct only for Base Sepolia USDC. On Base mainnet USDC the EIP-712 domain name is `"USD Coin"`, so the wrong default produced signatures the facilitator could never verify. The default is now keyed by the asset contract for the well-known USDC deployments (Base mainnet + Base Sepolia); other tokens fall back to the previous default and should supply their own `extra`.

- [#190](https://github.com/planetarium/a2x/pull/190) [`efb8c51`](https://github.com/planetarium/a2x/commit/efb8c51918353b24a8036abd5e4320b82f2cef3d) Thanks [@longfin](https://github.com/longfin)! - x402: mark `X402_EXTENSION_URI` `@deprecated` as an AgentCard-advertised URI.

  New deployments should advertise `X402_FOUNDATION_EXTENSION_URI` — the URI the x402 Foundation A2A transport mandates. Registering the legacy v0.2 URI from a client (`extensions: [X402_EXTENSION_URI]`) remains supported as the documented "this client decodes V1 only" declaration; only advertising it on a card is deprecated.

- [#190](https://github.com/planetarium/a2x/pull/190) [`efb8c51`](https://github.com/planetarium/a2x/commit/efb8c51918353b24a8036abd5e4320b82f2cef3d) Thanks [@longfin](https://github.com/longfin)! - x402: settle receipts fall back to the matched requirement's network when the payload cannot name one.

  `payloadNetwork` returns `''` for a V2 payload with no `accepted` echo (required by the type, but a wire peer can omit it at runtime), and `X402Context.settle` wrote that empty string into the receipt's `network` field. Both receipt paths (success and settle-failure) now fall back to `classified.requirement.network`, which `classify` has already encoded for the offered version, so the receipt names the network in the right per-version form.

## 0.15.0

### Minor Changes

- [#169](https://github.com/planetarium/a2x/pull/169) [`4481309`](https://github.com/planetarium/a2x/commit/4481309fad7c8febe3f90a2eb75f2b441b86428a) Thanks [@ost006](https://github.com/ost006)! - Rename `A2XAgent` to `A2XServer`. The class is the A2A protocol _server_ wrapper (task store, executor, AgentCard builder), not an agent — the old name collided with `LlmAgent` and suggested that tools/skills belonged on it. `A2XServerOptions` replaces `A2XAgentOptions`, and `toA2x()` now returns `a2xServer` on its result.

  Backward compatible: `A2XAgent`, `A2XAgentOptions`, and `ToA2xResult.a2xAgent` remain as `@deprecated` aliases of the new names and will be removed in a future major. `A2XAgentSkill` and `A2XAgentState` (AgentCard types) are unchanged.

- [#171](https://github.com/planetarium/a2x/pull/171) [`a3a872b`](https://github.com/planetarium/a2x/commit/a3a872b2680e849dd1e29cdb1c57ce862280ad26) Thanks [@ost006](https://github.com/ost006)! - Export `TaskEventBus` and `InMemoryTaskEventBus` from the package entry. The `taskEventBus` constructor option on `A2XServer` was already public, but its supporting types were not exported, so callers could not type a custom bus (as the manual-wiring guide showed). They are now importable from `@a2x/sdk`.

  Also re-syncs documentation with the current public surface: corrects the `request-input` / resume model in the agent guide (the SDK keeps no cross-turn state — agents read `context.message`), fixes the client error-handling guide (auth failures surface as a `Task` in `auth-required` state, not a removed `AuthenticationRequiredError`; the JSON-RPC error-code table now matches `A2A_ERROR_CODES`), and drops references to non-existent security scheme classes.

## 0.14.0

### Minor Changes

- [#163](https://github.com/planetarium/a2x/pull/163) [`02a4f89`](https://github.com/planetarium/a2x/commit/02a4f8980a615873fc68ab071d4607bf7f3eb790) Thanks [@ost006](https://github.com/ost006)! - x402: remove SDK-owned payment flow; ship stateless helpers + X402Context façade only; move x402 surface to dedicated subpath

  The SDK no longer owns the x402 payment flow. `x402PaymentHook`,
  `readX402Settlement`, `X402_DOMAIN`, the `inputRoundTripHooks`
  `AgentExecutor` option, and every `InputRoundTrip*` type are removed.
  The `_a2x.inputRoundTrip` bookkeeping that previously leaked onto the
  wire on every `input-required` response is gone with them.

  The agent now owns the entire payment lifecycle inside
  `BaseAgent.run()`. Use the new `X402Context` façade for the common
  case, or compose the stateless helpers it's built on for full bespoke
  control:

  - `X402Context` / `BaseX402Context` — façade bundling the offering
    store, facilitator, and event builders. Tracks status / receipts /
    failures per task via `BaseX402Store` (default: `InMemoryX402Store`).
  - `parseX402PaymentSubmission`, `pickX402Requirement`,
    `validateX402PayloadShape`, `normalizeX402Accept`, and the
    `buildX402Payment*Metadata` family — stateless helpers, one step each.

  The `request-input` AgentEvent drops its `domain` and `payload` fields;
  `done` and `error` events accept an optional `metadata` field that the
  executor merges onto the final status message. `InvocationContext`
  gains a `message` field carrying the current turn's incoming `Message`
  so agents can detect resume conditions by inspecting message metadata
  directly.

  **Import path change.** The entire x402 surface — `X402Context`,
  `X402_EXTENSION_URI`, `signX402Payment`, `getX402PaymentRequirements`,
  `getX402Receipts`, every `build*Metadata` helper, every type — now
  lives on the dedicated `@a2x/sdk/x402` subpath. The main `@a2x/sdk`
  entry no longer re-exports any of it. This lets agents that don't
  charge for payments skip installing the `x402` and `viem` peer
  dependencies entirely.

  ```ts
  // Before
  import { X402Context, signX402Payment } from "@a2x/sdk";

  // After
  import { X402Context, signX402Payment } from "@a2x/sdk/x402";
  ```

  `A2XClientX402Options` (the constructor-option type on `A2XClient`)
  stays on the main entry — it's a client-config type, not an x402-feature
  import.

  Wire format is unchanged — every `x402.payment.*` metadata key, status
  value, and error code is bit-for-bit identical. Existing A2A clients
  keep working without modification. See
  `docs/guides/advanced/migration-x402-v2.md` for the migration steps.

## 0.13.2

### Patch Changes

- [#165](https://github.com/planetarium/a2x/pull/165) [`93c6e69`](https://github.com/planetarium/a2x/commit/93c6e6971cefc6d6fc25805e113082cf75de7d43) Thanks [@TateLyman](https://github.com/TateLyman)! - Keep optional x402 runtime imports opaque so bundlers do not require x402 when apps only import `@a2x/sdk/client`.

## 0.13.1

### Patch Changes

- [#159](https://github.com/planetarium/a2x/pull/159) [`979f391`](https://github.com/planetarium/a2x/commit/979f3914928756a6b6344aee9f0a300b174bf9e9) Thanks [@ost006](https://github.com/ost006)! - `InvocationContext` now exposes `taskId` and `contextId` so agent code
  has a stable per-task identifier to bind durable state to.

  Closes [#158](https://github.com/planetarium/a2x/issues/158).

  **Why.** The default `AgentExecutor` creates a fresh `Session` on every
  invocation (`runner.createSession()` runs on both the first turn and
  each resume turn), so `context.session.id` was a per-invocation UUID,
  not a per-task one. Agents that stored `task_id = context.session.id`
  on the `request-input` turn (e.g. an x402 payment intent row) saw a
  different `session.id` on the resume turn and could not recover the
  record. The A2A wire protocol's `Task.id` (and `contextId`) was the
  right identifier all along, but it wasn't surfaced on the agent's
  context.

  **What's new.**

  - `InvocationContext` gains two optional fields, set by the default
    `AgentExecutor`:
    - `taskId` — the A2A `Task.id`, stable across `request-input` →
      resume turns of the same task.
    - `contextId` — the A2A `contextId`, stable across every task in
      the same conversation (1:N with `taskId`).
  - `Runner.runAsync()` accepts an optional fourth `taskScope`
    argument carrying these identifiers. The default `AgentExecutor`
    passes `{ taskId: task.id, contextId: task.contextId ?? task.id }`
    on both `execute()` and `executeStream()` paths.
  - Agent authors should bind per-task durable state to
    `context.taskId` (not `context.session.id`). `session.id` keeps its
    existing per-invocation lifecycle and is intentionally unchanged.

  **Compatibility.** Additive on every public surface. Existing agents
  that read `context.session.id` continue to compile and run; the bug
  they hit (re-binding state across resume) is what this change fixes.
  Standalone `Runner` callers that don't go through the `AgentExecutor`
  leave `taskId` / `contextId` undefined, same as before.

## 0.13.0

### Minor Changes

- [#154](https://github.com/planetarium/a2x/pull/154) [`91b54ab`](https://github.com/planetarium/a2x/commit/91b54abed4b54c1e716ee4cafe4901c2f25264d7) Thanks [@ost006](https://github.com/ost006)! - Redesign the x402 surface around input-required round-trips. The
  `X402PaymentExecutor` class is removed; agents now express payment
  gating inline in `BaseAgent.run()` via the new `request-input`
  AgentEvent and the `x402RequestPayment` / `x402PaymentHook` /
  `readX402Settlement` helpers.

  `AgentExecutor` gains an `inputRoundTripHooks` option (and a
  `registerInputRoundTripHook` method) so the same machinery extends to
  non-payment domains (approvals, OAuth tokens, etc.) without further SDK
  changes.

  Wire format is unchanged — existing clients keep working without
  modification. Removed exports: `X402PaymentExecutor`,
  `X402PaymentExecutorOptions`. New exports: `x402RequestPayment`,
  `x402PaymentHook`, `readX402Settlement`, `X402_DOMAIN`,
  `X402RequestPaymentInput`, `X402PaymentHookOptions`,
  `InputRoundTripRecord`, `InputRoundTripOutcome`, `InputRoundTripHook`,
  `InputRoundTripContext`, `INPUT_ROUNDTRIP_METADATA_KEY`.

  See `docs/guides/advanced/migration-x402-v2.md` for the 1:1 mapping
  from the old surface.

## 0.12.0

### Minor Changes

- [#150](https://github.com/planetarium/a2x/pull/150) [`fe225a1`](https://github.com/planetarium/a2x/commit/fe225a1176105b94c3251de7f415db648dad72a7) Thanks [@ost006](https://github.com/ost006)! - `AgentEvent` now supports `file` and `data` variants alongside `text`, so
  multi-modal agents (image generation, structured output, document creation,
  …) can stay on the `BaseAgent` path without dropping to a custom
  `AgentExecutor`.

  Closes [#148](https://github.com/planetarium/a2x/issues/148).

  **Why.** A2A v0.3 already defines first-class non-text part shapes
  (`FilePart`, `DataPart`) and the SDK's internal `Part` union has matched
  that since day one. But `AgentEvent` — the contract between agent code
  and the runner/executor — only had a `text` data variant, so non-text
  output had no expression on the `BaseAgent` path: the default
  `AgentExecutor.executeStream` translated `text` into artifact text-parts
  and silently dropped everything else. The only workaround was to abandon
  `BaseAgent` and emit raw `TaskArtifactUpdateEvent`s from a custom
  `AgentExecutor`, which leaks A2A protocol details into agent code.

  **What's new.**

  - `AgentEvent` adds `{ type: 'file', file: {...} }` and
    `{ type: 'data', data, mediaType? }` variants. The `text` variant gains
    an optional `mediaType` field for distinguishing `text/markdown`,
    `application/json`, etc.
  - The default `AgentExecutor` (both `execute()` and `executeStream()`)
    maps each non-text event to a fresh artifact: `file` → `FilePart`
    artifact, `data` → `DataPart` artifact, each with a unique
    `artifactId`. Text events keep their existing accumulation behavior
    (single text artifact per task, append-mode chunks during streaming).
  - `LlmAgent.run()` no longer filters non-text parts out of the LLM
    response — they are yielded as `file` / `data` events. (The bundled
    Anthropic / OpenAI / Google provider converters today only emit text
    blocks from chat-completion responses; non-text output mostly applies
    to custom `BaseAgent` implementations.)

  **Compatibility.** Additive on the wire: clients receive standard A2A
  v0.3 `FilePart` / `DataPart` artifacts, which `A2XClient` and its
  response parser already supported. Existing text-only agents and
  clients continue to work unchanged.

  `switch (event.type) { … }` blocks over `AgentEvent` without a
  `default:` branch will need new `case 'file'` / `case 'data'` arms (or
  a `default:`) under TypeScript's strict-exhaustiveness checks.

## 0.11.1

### Patch Changes

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - `isFilePart()` now recognizes the v0.3 spec FilePart wire shape in
  addition to the SDK's flat internal shape.

  Closes [#142](https://github.com/planetarium/a2x/issues/142) (fix 4 of 5).

  **Why.** v0.3 `FilePart` (`a2a-v0.3.0.json:828`) is nested:
  `{ kind: 'file', file: { bytes | uri, mimeType?, name? } }`. The
  pre-fix guard only matched the SDK's internal flat shape (`{ raw }` /
  `{ url }`), so a spec-conformant FilePart coming off the wire fell
  through every part type guard and was silently classified as none. The
  v0.3 response mapper output already produced the nested shape
  correctly — only input classification was asymmetric.

  **Fix.** The guard now also returns `true` for
  `{ kind: 'file', file: { ... } }`. `isTextPart` and `isDataPart`
  already handled their respective shapes correctly and are unchanged.

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - Push notification webhooks now POST the spec-mapped Task wire shape, not
  the internal `Task` object.

  Closes [#142](https://github.com/planetarium/a2x/issues/142) (fix 1 of 5).

  **Why.** `DefaultRequestHandler._dispatchPushNotifications` handed the
  raw internal `Task` to `PushNotificationSender.send`, which
  `JSON.stringify`d it straight onto the wire. v1.0 receivers got
  `state: "completed"` / `role: "agent"` (lowercase) instead of
  `TASK_STATE_COMPLETED` / `ROLE_AGENT`, and v0.3 receivers got Task /
  Message / Part objects without the required `kind` discriminator. The
  body never matched what the same task served via `tasks/get` would
  have looked like.

  **Fix.** The dispatcher now runs the task through the same
  `ResponseMapper` that produces the JSON-RPC response (v0.3 `kind` /
  v1.0 UPPER_CASE) before handing the body to the sender.

  **Public surface.** `PushNotificationSender.send(config, body: unknown)`
  replaces `send(config, task: Task)` — the second parameter is now the
  already-version-mapped wire payload. Custom sender implementations
  should update their parameter type; the runtime semantics
  (`JSON.stringify(value)`) are unchanged. The default
  `FetchPushNotificationSender` is updated in place.

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - `tasks/pushNotificationConfig/set` now accepts the v1.0 flat input
  shape so clients can round-trip the response the server just gave
  them.

  Closes [#142](https://github.com/planetarium/a2x/issues/142) (fix 2 of 5).

  **Why.** `V10ResponseMapper.mapPushNotificationConfig` returns the flat
  shape defined by `a2a-v1.0.0.proto:464`
  (`{ taskId, id, url, token?, authentication?, tenant? }`), but the
  validator on `tasks/pushNotificationConfig/set` required the v0.3
  nested `pushNotificationConfig` field on every protocol version. A
  v1.0 client that received a config from `get`/`list` and tried to send
  it back to `set` would be rejected with `InvalidParams`.

  **Fix.** The validator branches on `protocolVersion`. On `1.0` it
  accepts the flat shape (top-level `url`/`id`/`token`/`authentication`);
  on `0.3` it continues to require the nested form. The internal storage
  representation is unchanged — the validator normalizes both inputs
  into the same `{ taskId, pushNotificationConfig: { ... } }` value the
  store keys on.

  `get`, `list`, and `delete` already branched on protocol version; only
  `set` was missing the v1.0 path.

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - The SSE stream parser now surfaces mid-stream JSON-RPC error envelopes
  as thrown errors instead of silently dropping them.

  Closes [#142](https://github.com/planetarium/a2x/issues/142) (fix 5 of 5).

  **Why.** When a server-side handler threw mid-stream,
  `DefaultRequestHandler._wrapStreamInJsonRpc` yielded a single JSON-RPC
  error envelope (`{ jsonrpc, id, error: { code, message, data? } }`)
  before closing the connection — exactly as the streaming guide already
  documents. But `parseSSEStream`'s `unwrapData` only unwrapped `result`;
  the `error` envelope was classified as a generic `MESSAGE` event, and
  the switch in `parseSSEStream` had no `MESSAGE` arm, so the chunk was
  dropped without ever being yielded or thrown. Clients saw the stream
  end as though the task had completed silently.

  **Fix.** `unwrapData` now detects a JSON-RPC error envelope and throws
  an `Error` with the server's `message` and `code`. The thrown error
  propagates out of `parseSSEStream`, terminating the iterator with a
  meaningful message — matching what the streaming guide already
  promises.

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - `toA2x()` and `createA2xRequestListener()` now serve the AgentCard at
  both `/.well-known/agent.json` and `/.well-known/agent-card.json`.

  Closes [#142](https://github.com/planetarium/a2x/issues/142) (fix 3 of 5).

  **Why.** The SDK's own `resolveAgentCard()` tries the modern
  `/.well-known/agent-card.json` first and falls back to the v0.3
  `/.well-known/agent.json`. The Next.js samples already expose both
  routes, but plain `toA2x()` users only got the legacy path — a client
  that hit the modern path first received a 404 and only saw the card
  after a fallback round trip (or, with strict client configurations,
  not at all).

  **Fix.** Both well-known paths route to `handler.getAgentCard()` and
  return the same body. No other behavior change.

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - `@a2x/sdk/client` no longer pulls `x402` into the bundle at build time
  when consumers don't use it.

  Closes [#134](https://github.com/planetarium/a2x/issues/134).

  **Why.** `x402` is declared as an optional peer dependency, but its
  runtime helpers were statically imported into the
  `@a2x/sdk/client` chunk. Bundlers (Next.js, Vite, esbuild, …) treated
  the import as required and either failed the build or shipped the
  package even on code paths that never signed a payment.

  **Fix.** `signX402Payment` now lazy-imports the `x402` runtime inside
  the function body, so the static `import` graph of the client chunk
  no longer references it. Consumers who never invoke an x402-gated flow
  do not need to install `x402`. The static imports in
  `dist/client/*.js` are gone — verifiable by grepping the published
  bundle.

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - Every x402 settlement receipt now carries the `payer` address, including
  failure rows.

  Closes [#143](https://github.com/planetarium/a2x/issues/143) (fix 2 of 4).

  **Why.** x402-v1 §5.3.2 requires the payer wallet address on every
  receipt the merchant emits, success or failure. Before, the SDK
  populated `payer` only on success rows; failure receipts went out
  without it, breaking spec-conformant downstream auditors.

  **Fix.** `payer: string` is now required on the internal X402Receipt
  type, and both the blocking and streaming executor paths thread the
  payer address into every receipt — including the failure-row branch
  that previously omitted it.

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - Add `rejectX402Payment(task)` primitive and let `onPaymentRequired`
  return `false` to send a payment-rejected message on the merchant's
  task.

  Closes [#143](https://github.com/planetarium/a2x/issues/143) (fix 1 of 4).

  **Why.** Per a2a-x402 v0.2 §5.4.2, a payer that declines an x402
  challenge SHOULD send a payment-rejected message back on the same task
  so the merchant can clean up. Throwing from `onPaymentRequired` in
  `A2XClient` aborted locally without telling the server, leaving the
  task in a permanent `payment-required` limbo.

  **Fix.** New export `rejectX402Payment(task)` builds the spec-shaped
  rejection metadata for a given task. `A2XClient.onPaymentRequired`
  recognizes a `false` return value and submits the rejection on the
  same task automatically. Throwing still aborts locally for callers who
  prefer that semantics; returning `false` ends the merchant's task
  cleanly.

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - `A2XClient` now decides x402 outcomes on the **latest** receipt plus the
  task state, recognizes the server-side `retryOnFailure` re-prompt, and
  adds an opt-in `maxRetries` for automatic re-sign on the same task.

  Closes [#143](https://github.com/planetarium/a2x/issues/143) (fix 4 of 4).

  **Why.** The pre-fix client scanned the full receipt history and threw
  on _any_ historical failure, even when the merchant had since prompted
  the payer to retry and a successful receipt followed. That mishandled
  the spec's intended retry flow (a2a-x402 v0.2 §5.5): a failed receipt
  followed by `input-required + payment-required` is a re-prompt, not a
  terminal failure.

  **Fix.** `_evaluatePaymentOutcome` now reads the latest receipt and
  the task state together. A re-prompt (input-required + payment-required
  metadata) is surfaced to `onPaymentRequired` instead of throwing, so
  callers can decide whether to re-sign. New
  `A2XClientX402Options.maxRetries` (default `0`) opts into automatic
  re-sign on the same task — the client signs, submits, observes the
  outcome, and loops up to `maxRetries + 1` total attempts before giving
  up.

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - `signX402Payment` now rejects unsupported `x402Version` values up front
  with a typed `X402InvalidVersionError` instead of crashing inside the
  underlying `createPaymentHeader` call.

  Closes [#143](https://github.com/planetarium/a2x/issues/143) (fix 3 of 4).

  **Why.** x402-v1 §9 lists `invalid_x402_version` as a defined error
  code. The SDK never surfaced it: a non-1 `x402Version` in a payment
  requirement crashed inside `x402.createPaymentHeader` with an opaque
  error message, leaving callers no way to handle the version mismatch
  without parsing strings.

  **Fix.** New `X402InvalidVersionError` (exported alongside the other
  `X402*Error` classes) is thrown from `signX402Payment` when the
  requirement's `x402Version` is not `1`. The error carries the spec
  code `invalid_x402_version` (also added to `X402_ERROR_CODES` as
  `INVALID_X402_VERSION`) so callers can branch on it.

## 0.11.0

### Minor Changes

- [#138](https://github.com/planetarium/a2x/pull/138) [`b687ae2`](https://github.com/planetarium/a2x/commit/b687ae2212ada1eff33bfcffbca0a7ac6cef5b64) Thanks [@ost006](https://github.com/ost006)! - Remove the `version` parameter from `A2XAgent.getAgentCard()` and
  `DefaultRequestHandler.getAgentCard()`. The card is now always rendered in the
  agent's configured `protocolVersion` — the same wire format the server actually
  speaks.

  Closes [#133](https://github.com/planetarium/a2x/issues/133).

  **Why.** The server's wire format is fixed at construction time (the
  `protocolVersion` chosen on `new A2XAgent({...})` selects a single
  `responseMapper`). Letting `getAgentCard(version)` render a card in a different
  version published a contract the server could not honor: response shapes
  (`TASK_STATE_COMPLETED` vs `'completed'`), role/part encoding (`ROLE_USER` vs
  `'user'`, `kind` discriminator presence), and `pushNotificationConfig/{set,delete}`
  param shape are all bound to the configured version. A v1.0 agent serving a
  v0.3 card silently broke every call from a conforming v0.3 client, because
  `A2XClient.detectProtocolVersion()` honors the card's declared version
  absolutely.

  **Breaking — removals.**

  - `A2XAgent.getAgentCard(version?)` — the `version` parameter is removed.
  - `DefaultRequestHandler.getAgentCard(version?)` — the `version` parameter is
    removed.
  - The `?version=` query string on `GET /.well-known/agent.json` (built-in
    `to-a2x` HTTP server) is no longer honored.

  In-tree callers that already passed no argument (`samples/express`,
  `samples/nextjs`, `samples/nextjs-skill`, `samples/nextjs-x402`) are
  unaffected. Callers that previously did `getAgentCard('0.3')` against a v1.0
  agent (or vice versa) were creating the foot-gun this fix removes — the
  correct migration is to construct a separate `A2XAgent` with the desired
  `protocolVersion`:

  ```ts
  // Before — silently broken: card said v0.3, wire still spoke v1.0
  const card03 = a2xAgent.getAgentCard("0.3");

  // After — one agent per wire format
  const a2xAgentV03 = new A2XAgent({
    taskStore,
    executor,
    protocolVersion: "0.3",
  });
  const card03 = a2xAgentV03.getAgentCard();
  ```

- [#138](https://github.com/planetarium/a2x/pull/138) [`ac24460`](https://github.com/planetarium/a2x/commit/ac24460bd24b96c640786f9a023b9a77be910688) Thanks [@ost006](https://github.com/ost006)! - Align `MessageSendConfiguration` and `TaskQueryParams` with spec a2a-v0.3.
  Three drift fixes plus an `A2XClient` ergonomic gap.

  Closes [#120](https://github.com/planetarium/a2x/issues/120).

  **Breaking — renames.** `SendMessageConfiguration.returnImmediately`
  (SDK-private, inverted) is replaced with `blocking` (spec-canonical). The
  client's wire-emit path used to translate `returnImmediately → blocking`; that
  translation is now a no-op passthrough.

  ```ts
  // Before
  client.sendMessage({ message, configuration: { returnImmediately: true } });

  // After
  client.sendMessage({ message, configuration: { blocking: false } });
  ```

  **New — inline push-notification config.**
  `SendMessageConfiguration.pushNotificationConfig` is now honored. The request
  handler registers the inline config in the configured
  `PushNotificationConfigStore` before kicking off execution, so clients can
  subscribe in a single round-trip. Throws `PushNotificationNotSupported` when
  no store is configured. Pairs with the actual delivery wiring shipping in this
  release.

  **Fix — `tasks/get` honors `historyLength`.** The method was wired to
  `_validateTaskIdParams` and silently ignored the spec's
  `TaskQueryParams.historyLength`. Added a dedicated `_validateTaskQueryParams`
  validator (rejects non-integer / negative values) and a `sliceHistory()`
  helper that trims the response Task's `history` to the requested bound. The
  same slicing applies on the unary `message/send` response.

  **New — `A2XClient.getTask({ historyLength?, metadata? })`.** The spec's bound
  is now reachable from the public client API.

  Spec refs:

  - v0.3 §`MessageSendConfiguration` (`a2a-v0.3.0.json:1669-1693`)
  - v0.3 §`TaskQueryParams` (`a2a-v0.3.0.json:2385-2406`)
  - v0.3 §`GetTaskRequest.params` (`a2a-v0.3.0.json:1090`) — uses
    `TaskQueryParams`, not `TaskIdParams`.

- [#138](https://github.com/planetarium/a2x/pull/138) [`ac24460`](https://github.com/planetarium/a2x/commit/ac24460bd24b96c640786f9a023b9a77be910688) Thanks [@ost006](https://github.com/ost006)! - Deliver push-notification webhooks on terminal task state, and stop falsely
  advertising the capability when no sender is wired.

  Closes [#119](https://github.com/planetarium/a2x/issues/119).

  **Why.** The SDK accepted `tasks/pushNotificationConfig/{set,get,list,delete}`
  calls and persisted configs to the store, but no code ever POSTed to the
  webhook URL when a task transitioned. Worse, the AgentCard auto-flipped
  `capabilities.pushNotifications: true` as soon as a config store was wired —
  spec-aware clients that read the capability and skipped polling never received
  any notification, and the task appeared stuck.

  **New — `PushNotificationSender` interface.** Pluggable sender abstraction
  plus a default `FetchPushNotificationSender` that POSTs the JSON-encoded task
  body to `config.url`. Forwards `token` as `X-A2A-Notification-Token` and
  `Bearer` credentials from `authentication`. Best-effort by spec — delivery
  failures are logged via an injectable `onError` callback, never thrown into
  the task pipeline.

  ```ts
  import { A2XAgent, FetchPushNotificationSender } from "@a2x/sdk";

  const a2xAgent = new A2XAgent({
    taskStore,
    executor,
    pushNotificationConfigStore, // existing
    pushNotificationSender: new FetchPushNotificationSender(), // new
  });
  ```

  **Behavior change — capability auto-derivation tightened.**
  `capabilities.pushNotifications` now flips to `true` only when **both** a
  `PushNotificationConfigStore` **and** a `PushNotificationSender` are wired. An
  explicit value via `setPushNotifications()` still wins. This stops the SDK
  from shipping a false-positive AgentCard. Existing deployments that wired only
  a store will see the capability flip from `true` (incorrect, never delivered)
  to `false` (correct) until a sender is added.

  **Wiring.** `DefaultRequestHandler` invokes the sender on terminal state
  (after `message/send` completes and after the streaming generator yields a
  terminal event). Fire-and-forget so a slow webhook can't stall the response
  path.

  Tests cover capability auto-derivation in both directions, webhook fire on
  terminal state from both `message/send` and `message/stream`,
  `FetchPushNotificationSender` headers (token, Bearer auth), and
  transport-failure resilience.

- [#138](https://github.com/planetarium/a2x/pull/138) [`ac24460`](https://github.com/planetarium/a2x/commit/ac24460bd24b96c640786f9a023b9a77be910688) Thanks [@ost006](https://github.com/ost006)! - Make `resource` and `description` required on `X402Accept`. The x402 executor
  used to fabricate two `PaymentRequirements` MUST-fields when the merchant
  omitted them — defaults that violated the spec.

  Closes [#123](https://github.com/planetarium/a2x/issues/123).

  **Why.** Per x402 v1 §`PaymentRequirements`:

  - `resource` MUST be a URL identifying what is being paid for. The SDK
    defaulted it to the literal string `'a2a-x402/access'` (not a URL). Strict
    facilitators reject this.
  - `description` MUST describe the purchase. The SDK defaulted it to `''`,
    which surfaces in wallet UIs as the consent prompt — users were being asked
    to sign for a payment whose purpose is "(empty)".

  **Breaking — type tightening.**

  - `X402Accept.resource: string` (was `string | undefined`).
  - `X402Accept.description: string` (was `string | undefined`).
  - `X402_DEFAULT_RESOURCE` export is removed.
  - `description ?? ''` fallback inside `normalizeAccept` is removed.

  The TypeScript compiler now forces merchants to supply spec-conformant values.
  Existing code that relied on the defaults must pass real values:

  ```ts
  // Before — silently shipped non-URL resource and empty description
  agent.addExtension(
    { uri: X402_EXTENSION_URI },
    {
      accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "..." }],
    }
  );

  // After — required fields enforced at compile time
  agent.addExtension(
    { uri: X402_EXTENSION_URI },
    {
      accepts: [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "...",
          resource: "https://api.example.com/premium",
          description: "Premium agent access",
        },
      ],
    }
  );
  ```

  Samples, docs, and test fixtures are updated to pass real values.

### Patch Changes

- [#138](https://github.com/planetarium/a2x/pull/138) [`ac24460`](https://github.com/planetarium/a2x/commit/ac24460bd24b96c640786f9a023b9a77be910688) Thanks [@ost006](https://github.com/ost006)! - Return HTTP 200 with a JSON-RPC error body for parse failures and handler
  exceptions in the bundled HTTP wrappers (`toA2x()` and the four samples). The
  JSON-RPC over HTTP convention is to keep the HTTP layer at `200` and surface
  the error code in the response body — clients that skip body parsing on `4xx`
  never see the JSON-RPC code otherwise.

  Closes [#122](https://github.com/planetarium/a2x/issues/122).

  **Why.** `DefaultRequestHandler.handle()` already followed this convention for
  string bodies (it returned a `JSONParseError` JSON-RPC response, not a thrown
  error). The bug was confined to the HTTP wrappers above it: `toA2x()`, the
  Express sample, and the three Next.js samples all returned HTTP `400` for
  malformed JSON and any handler exception. A spec-conforming client that read
  status code as "no body to parse" would miss the `-32700 Parse error` /
  `-32603 Internal error` payload.

  **Changes.**

  - `transport/to-a2x.ts`: narrows the parse-error catch to `JSON.parse` only,
    adds a separate handler-exception catch that emits `-32603` with the
    request id (or `null` when params are unparseable). Both paths return HTTP
    `200`.
  - `transport/to-a2x.ts`: extracts the request listener into the new exported
    `createA2xRequestListener()` so the dispatch can be unit-tested without
    going through `listen()`.
  - `samples/express`, `samples/nextjs`, `samples/nextjs-skill`,
    `samples/nextjs-x402`: same treatment, mirrored for the App Router shape.

  Adds `to-a2x-http.test.ts` covering the malformed-body and unknown-method
  paths to lock the HTTP-200 contract in.

- [#117](https://github.com/planetarium/a2x/pull/117) [`45463f8`](https://github.com/planetarium/a2x/commit/45463f8079cc2c3a48823e015e5add1d6b70d5ea) Thanks [@ost006](https://github.com/ost006)! - Stop logging a `console.warn` from
  `OAuth2DeviceCodeAuthorization.toV03Schema()`. The warning fired on every v0.3
  AgentCard render — i.e. on every `GET /.well-known/agent.json?version=0.3` and
  every `agent/getAuthenticatedExtendedCard` call — even though emitting Device
  Code as a non-standard `oauth2.flows.deviceCode` extension is the SDK's
  intentional behavior. The non-standard nature is already documented on the
  method's JSDoc and in the authentication guide; the per-render log was pure
  noise.

- [#138](https://github.com/planetarium/a2x/pull/138) [`ac24460`](https://github.com/planetarium/a2x/commit/ac24460bd24b96c640786f9a023b9a77be910688) Thanks [@ost006](https://github.com/ost006)! - Wrap each SSE chunk in a JSON-RPC success envelope keyed by the originating
  request id, per spec a2a-v0.3 §`SendStreamingMessageSuccessResponse`. The
  previous wire shape (`event: status_update` / `event: artifact_update` framing
  plus a non-spec `event: done` terminator) was interop-broken with any
  non-a2x peer (Python ADK, official samples, third-party gateways) — it
  worked only because the a2x client parser tolerated both formats.

  Closes [#118](https://github.com/planetarium/a2x/issues/118).

  **Wire shape — before:**

  ```
  event: status_update
  data: {"taskId":"...","status":{...}}

  event: done
  ```

  **Wire shape — after:**

  ```
  data: {"jsonrpc":"2.0","id":<request-id>,"result":{"taskId":"...","status":{...}}}
  ```

  Stream end is signalled by connection close after the terminal status
  (`final: true` in v0.3); the non-spec `event: done` chunk is gone.

  **Changes.**

  - `DefaultRequestHandler.handle()` now wraps the streaming generator in
    JSON-RPC envelopes (`_wrapStreamInJsonRpc`) for both the routed stream
    methods and the auth-required stream synthesis. Mid-stream errors yield a
    single trailing JSON-RPC error envelope instead of throwing, so clients
    keyed on the request id can correlate the failure.
  - `createSSEStream()` is now a generic `data:`-only encoder — drops the
    `event:` field and the trailing `event: done` terminator.
  - The client SSE parser keeps tolerating the legacy framed shape for one
    minor for upgrade compatibility, but emits a one-time deprecation warning
    when it sees it. **The legacy path will be removed in the next minor.**

  Tests, fixtures, and the streaming guides are updated to consume the new
  shape.

## 0.10.1

### Patch Changes

- [#115](https://github.com/planetarium/a2x/pull/115) [`ab17555`](https://github.com/planetarium/a2x/commit/ab1755510d973d8ef1ffdb80fd1403e9e499ee27) Thanks [@ost006](https://github.com/ost006)! - Fix `detectProtocolVersion` (and therefore `A2XClient`) to honor the AgentCard's
  declared top-level `protocolVersion` field before falling back to shape
  heuristics. Per `a2a-v0.3.0.json`, `protocolVersion` is required on v0.3 cards;
  per `a2a-v1.0.0.json`, it does not exist at the top level. The previous
  shape-only check misclassified v0.3 agents that legally advertise
  `supportedInterfaces` for additional transports as v1.0, which skipped the v0.3
  wire transform and shipped message parts without the required `kind`
  discriminator. The server then dropped the parts and rejected the request.

- [#111](https://github.com/planetarium/a2x/pull/111) [`994da9c`](https://github.com/planetarium/a2x/commit/994da9cae3fcf9453b4285dfc79ab844a7165b2d) Thanks [@ost006](https://github.com/ost006)! - Fix `PushNotificationAuthenticationInfo` to match the v1.0 spec on the wire. The
  SDK previously emitted (and accepted) the v0.3 shape `{ schemes: string[] }` even
  on v1.0 transports, which violates `a2a-v1.0.0.json` (`{ scheme: string,
credentials? }`, `additionalProperties: false`). The internal store still keeps
  the v0.3 shape; the v1.0 response mapper now collapses `schemes` to `scheme` on
  output, and the inbound validator on a v1.0 agent now requires the `scheme`
  field and normalizes it back to `[scheme]` for storage. v0.3 agents are
  unchanged.

## 0.10.0

### Minor Changes

- [#106](https://github.com/planetarium/a2x/pull/106) [`257d893`](https://github.com/planetarium/a2x/commit/257d893d21fbf548e34dfe5ef5898bf04344006d) Thanks [@ost006](https://github.com/ost006)! - Align auth failure handling with A2A spec by surfacing failures as a `TaskState.auth-required` task instead of a non-standard `-32008` JSON-RPC error.

  Closes [#94](https://github.com/planetarium/a2x/issues/94).

  **Why.** The SDK previously returned a JSON-RPC error with code `-32008 AuthenticationRequiredError` on auth failures. That code is not part of the spec — v0.3 defines RPC error codes only up to `-32007 AuthenticatedExtendedCardNotConfiguredError`, and v1.0 does not define JSON-RPC error codes at all. A2A v0.3 (`TaskState.auth-required`) and v1.0 (`TASK_STATE_AUTH_REQUIRED`) both reserve a Task lifecycle state for this exact case. The SDK's own `A2XClient` token-refresh path was gated on `response.status === 401`, an HTTP status the server never produced — so it was unreachable in practice.

  **Server.** `DefaultRequestHandler` now branches on the failing request method:

  - `message/send` returns a Task with `status.state: 'auth-required'` (HTTP `200`).
  - `message/stream` emits a single `TaskStatusUpdateEvent` carrying `auth-required` and closes the stream (HTTP `200`).
  - All other methods (`tasks/get`, `tasks/cancel`, `tasks/pushNotificationConfig/*`, `agent/getAuthenticatedExtendedCard`) have no task-shaped response, so they fall back to spec-defined `-32600 InvalidRequest` with a descriptive message.

  The synthesized auth-required task is ephemeral — it's not persisted to the task store, so unauthenticated callers cannot allocate task IDs.

  **Client.** `A2XClient` no longer inspects `response.status === 401`. Instead, after parsing a `message/send` response or buffering the first event of a `message/stream` response, it checks for `status.state === 'auth-required'`. When `AuthProvider.refresh()` is configured, the client refreshes credentials and retries once — both for blocking and streaming calls. When `refresh()` is not configured, the auth-required task / event is returned to the caller unchanged.

  **Breaking — removals.** `AuthenticationRequiredError` and `A2A_ERROR_CODES.AUTHENTICATION_REQUIRED` (`-32008`) are removed. Consumers that imported either symbol must migrate to inspecting the Task state. HTTP status remains `200` in all cases — no host adapter changes are required (Next.js routes, Express handlers, the built-in `to-a2x` server, etc.).

## 0.9.0

### Minor Changes

- [#102](https://github.com/planetarium/a2x/pull/102) [`52093d8`](https://github.com/planetarium/a2x/commit/52093d883218530717ffa92178fdb3110ce9d0f4) Thanks [@ost006](https://github.com/ost006)! - Align `@a2x/sdk/x402` with a2a-x402 v0.2 spec, and fold x402 handling into `A2XClient` natively.

  Closes [#92](https://github.com/planetarium/a2x/issues/92). Two-part change:

  1. Six spec-conformance fixes (one MUST violation, five drift gaps).
  2. `X402Client` is removed — `A2XClient` itself runs the Standalone Flow when given an `x402` option, so callers no longer have to know up front whether the target agent gates on x402.

  **Breaking — client surface.** The `X402Client` wrapper class is gone. Migrate by passing the same options to `A2XClient` instead:

  ```ts
  // Before
  import { X402Client } from "@a2x/sdk/x402";
  const x402 = new X402Client(new A2XClient(url), { signer });
  await x402.sendMessage({ message });

  // After
  import { A2XClient } from "@a2x/sdk/client";
  const client = new A2XClient(url, { x402: { signer } });
  await client.sendMessage({ message });
  ```

  `A2XClient.sendMessage` and `A2XClient.sendMessageStream` now both transparently detect `payment-required`, sign one of the merchant's `accepts[]` requirements, and resubmit on the same task — the caller observes the final settled task (blocking) or a single merged event stream (streaming) with no manual orchestration. The streaming case in particular: the dance happens in-band, so consumers see `payment-required → payment-verified → working → artifacts → payment-completed` on one generator.

  The new `A2XClientX402Options` carries `signer`, optional `maxAmount` (atomic-unit ceiling enforced before the selector runs), `selectRequirement`, and `onPaymentRequired`. Setting `x402` automatically registers `X402_EXTENSION_URI` on the client's `extensions` set so the §8 header is emitted on every request.

  The low-level primitives (`signX402Payment`, `getX402PaymentRequirements`, `getX402Receipts`, `getX402Status`) remain exported for callers that need to drive the dance manually — e.g. inspect the `payment-required` task before signing.

  **Breaking — `X402_ERROR_CODES` renames.** Spec §9.1 defines the canonical code names. Two renames bring the SDK back in line:

  - `SETTLE_FAILED` → `SETTLEMENT_FAILED`
  - `AMOUNT_EXCEEDED` → `INVALID_AMOUNT`

  Also removed the unused `NO_REQUIREMENTS` code (never emitted). Consumers reading `x402.payment.error` string values or pattern-matching on these constants must update.

  **New — spec §9.1 error codes.** Verify failures now dispatch through `mapVerifyFailureToCode()`, which inspects the facilitator's `invalidReason` and returns one of `INSUFFICIENT_FUNDS`, `INVALID_SIGNATURE`, `EXPIRED_PAYMENT`, `DUPLICATE_NONCE`, or `VERIFY_FAILED` (fallback) instead of always emitting the generic `VERIFY_FAILED`.

  **New — `X-A2A-Extensions` activation header (§8 MUST).** `A2XClient` emits the header when extensions are registered:

  - new `A2XClientOptions.extensions?: string[]` option
  - new `A2XClient.registerExtension(uri)` method (idempotent)
  - new `A2XClient.activatedExtensions` read-only getter
  - setting `A2XClientOptions.x402` auto-registers `X402_EXTENSION_URI` so the header is emitted with no extra wiring

  Server-side, `DefaultRequestHandler` rejects requests whose header doesn't list every `required: true` extension on the AgentCard (error code `-32600`). Enforcement only runs when a `RequestContext` is supplied, so pure in-process handler invocations are unaffected.

  **New — `payment-verified` transient state (§7.1).** Streaming clients now observe a `working` + `x402.payment.status: payment-verified` event between `payment-submitted` and `payment-completed`, matching the spec's 3-step lifecycle.

  **Fix — `x402.payment.receipts` preserves history (§7).** Prior receipts are merged rather than overwritten across retries, honoring spec §7's "complete history" requirement.

  **New — `payment-rejected` handling (§5.4.2 / §7.1).** The executor now recognizes a client-sent `x402.payment.status: payment-rejected` and terminates the task (`failed` + status `payment-rejected`) instead of looping on `payment-required`.

  **New — `retryOnFailure` executor option.** Opt in to spec §9's retry branch: verify/settle failures re-publish `payment-required` on the same task with the failure reason carried in `X402PaymentRequiredResponse.error`, letting the client fix the issue and resubmit. Default behavior (terminate with `failed`) is unchanged.

## 0.8.0

### Minor Changes

- [#89](https://github.com/planetarium/a2x/pull/89) [`5a5c858`](https://github.com/planetarium/a2x/commit/5a5c858486212131dae55a662f6b18160a1bf1fd) Thanks [@ost006](https://github.com/ost006)! - Refactor `A2XAgent` capabilities API into focused builder methods.

  `setCapabilities()` is now `@deprecated` and will be removed in the next major.
  In the meantime, `setCapabilities({ extensions: [...] })` appends instead of
  overwriting so multi-source callers no longer clobber one another.

  New methods:

  - `addExtension(ext)` / `addExtension(uri, opts?)` — append to
    `capabilities.extensions`. Append-only, never drops earlier entries.
  - `setPushNotifications(enabled)` — override the auto-derived flag. The
    default is `true` when the constructor receives a
    `pushNotificationConfigStore` and `false` otherwise, so most callers no
    longer need to touch it.
  - `setStateTransitionHistory(enabled)` — v0.3-only flag (silently dropped
    from v1.0 cards).

  `capabilities.streaming` continues to be auto-extracted from
  `runConfig.streamingMode`, and `capabilities.extendedAgentCard` is still
  auto-set by `setAuthenticatedExtendedCardProvider()`.

  Migration:

  ```ts
  // Before
  a2xAgent.setCapabilities({
    pushNotifications: true,
    extensions: [{ uri: X402_EXTENSION_URI, required: true }],
    stateTransitionHistory: true,
  });

  // After
  a2xAgent
    .addExtension({ uri: X402_EXTENSION_URI, required: true })
    .setStateTransitionHistory(true);
  // pushNotifications: true is auto-derived from pushNotificationConfigStore.
  ```

## 0.7.0

### Minor Changes

- [#72](https://github.com/planetarium/a2x/pull/72) [`53e8e92`](https://github.com/planetarium/a2x/commit/53e8e928ed71e23efba670ee88ffd2e56b1046cc) Thanks [@ost006](https://github.com/ost006)! - Add a2a-x402 v0.2 payment support via a new `@a2x/sdk/x402` subpath.

  - **Server**: `X402PaymentExecutor` wraps any `AgentExecutor` and gates
    incoming messages behind on-chain payment. Emits `payment-required`
    with `X402PaymentRequiredResponse` when unpaid; on a signed
    `PaymentPayload` the SDK verifies and settles through a pluggable
    facilitator, then runs the inner executor and attaches a
    `X402SettleResponse` receipt to the completed task.
  - **Client**: `signX402Payment(task, { signer })` produces the metadata
    block a caller attaches to the follow-up `message/send`; `X402Client`
    wraps `A2XClient` and handles the full payment dance automatically.
  - **Types/constants**: `X402_EXTENSION_URI`, `X402_METADATA_KEYS`,
    `X402_PAYMENT_STATUS`, `X402_ERROR_CODES`, plus re-exports of
    `X402PaymentRequirements`, `X402PaymentPayload`, `X402SettleResponse`,
    `X402PaymentRequiredResponse`.
  - **Request handler**: `message/send` and `message/stream` now honor
    `message.taskId` and continue the referenced task when it's live and
    non-terminal, unblocking mid-task hand-offs like x402's
    `payment-required → payment-submitted`.

  `x402` and `viem` are added as optional peer dependencies — callers who
  don't use x402 don't need to install them. Pins to x402 v1
  (`x402Version: 1`), matching a2a-x402 v0.2.

## 0.6.0

### Minor Changes

- [#47](https://github.com/planetarium/a2x/pull/47) [`1b6b6a6`](https://github.com/planetarium/a2x/commit/1b6b6a6c6d374f4c3cd197a3ab27f3f6114b9a4c) Thanks [@ost006](https://github.com/ost006)! - feat(skills): integrate Claude Agent Skills open standard runtime

  Adds optional `skills` support to `LlmAgent` so any agent can load an
  open Claude Agent Skills directory (SKILL.md frontmatter + body + bundled
  files + scripts) or inline skills via `defineSkill()`. On activation the
  SDK registers three provider-agnostic builtin tools — `load_skill`,
  `read_skill_file`, `run_skill_script` — and injects the skill metadata
  block into the system prompt so Anthropic, OpenAI, and Google providers
  observe identical behaviour (progressive disclosure: eager metadata,
  lazy body, lazy references). Script execution is policy-aware
  (`allow` / `confirm` / `deny`) and audit-hook aware via
  `onScriptExecute`. Zero new runtime dependencies: a minimal YAML
  frontmatter parser is included. Existing agents are unaffected when the
  `skills` option is absent.

### Patch Changes

- [#49](https://github.com/planetarium/a2x/pull/49) [`b506378`](https://github.com/planetarium/a2x/commit/b506378f2592a004dc0faec3b8550d36cdbc3463) Thanks [@ost006](https://github.com/ost006)! - docs: cover SSE disconnect handling, `tasks/resubscribe`, and the authenticated extended card

  Extends the bundled guides to reflect the features landed in PRs [#42](https://github.com/planetarium/a2x/issues/42), [#43](https://github.com/planetarium/a2x/issues/43), [#44](https://github.com/planetarium/a2x/issues/44):

  - `guides/agent/streaming.md` — new "Client disconnect stops the work" and "Resuming a dropped SSE stream" sections, with guidance on wiring `res.on('close')` when hand-rolling an HTTP handler.
  - `guides/client/streaming.md` — new "Resuming a dropped stream" section showing the raw-JSON-RPC `tasks/resubscribe` pattern plus a note on the new cancel-on-disconnect contract.
  - `guides/advanced/manual-wiring.md` — documents `A2XAgentOptions.taskEventBus` with a sketch of a cross-process custom bus.
  - `guides/advanced/extended-agent-card.md` — **new** page covering `setAuthenticatedExtendedCardProvider`, overlay merge semantics, per-principal enrichment, and the `-32007` / `-32008` error codes. Linked from `authentication.md`, `agent-card-versioning.md`, and `manifest.json`.
  - `guides/agent/framework-integration.md` — Express snippet updated to include the `res.on('close')` disconnect wiring.

  Closes [#46](https://github.com/planetarium/a2x/issues/46).

- [#47](https://github.com/planetarium/a2x/pull/47) [`11483ae`](https://github.com/planetarium/a2x/commit/11483ae02b91df5a4d3879454e0b44ef9d54e555) Thanks [@ost006](https://github.com/ost006)! - fix(provider/anthropic): emit tool_use blocks after text blocks in assistant messages

  The Anthropic API treats a trailing tool_use block as the assistant's pending request and expects the next user message to begin with a matching tool_result. When the converter emitted tool_use before text inside the same assistant message, Anthropic rejected the conversation with `tool_use ids were found without tool_result blocks immediately after`, breaking any tool-calling flow where the model produced preamble text alongside a tool call.

## 0.5.0

### Minor Changes

- [#44](https://github.com/planetarium/a2x/pull/44) [`a478936`](https://github.com/planetarium/a2x/commit/a478936a2f0b8df2e3b2094c9d10e7afc50e4242) Thanks [@ost006](https://github.com/ost006)! - feat(a2x): implement `agent/getAuthenticatedExtendedCard` JSON-RPC method

  Adds a builder API `A2XAgent.setAuthenticatedExtendedCardProvider(fn)` that
  lets agent authors declare how to enrich the AgentCard for authenticated
  callers. When set, the SDK automatically advertises the capability on the
  base card (`supportsAuthenticatedExtendedCard` for v0.3,
  `capabilities.extendedAgentCard` for v1.0) and the new JSON-RPC method
  returns a merged card built from the base state plus the provider's overlay.
  Returns `AuthenticationRequiredError` when the call is unauthenticated and
  `AuthenticatedExtendedCardNotConfiguredError` when no provider is
  registered.

  Also corrects the method-name constant in `A2A_METHODS.GET_EXTENDED_CARD`
  from the non-compliant `'agent/authenticatedExtendedCard'` to the
  spec-defined `'agent/getAuthenticatedExtendedCard'`. This was never a
  functional method before, so no external callers are affected.

  Closes [#40](https://github.com/planetarium/a2x/issues/40).

- [#43](https://github.com/planetarium/a2x/pull/43) [`f84648f`](https://github.com/planetarium/a2x/commit/f84648fe52c4d064dd3ba36e079d21de32af6eb0) Thanks [@ost006](https://github.com/ost006)! - feat(transport): implement `tasks/resubscribe` JSON-RPC method

  Adds support for the v0.3 `tasks/resubscribe` method so clients that lose
  an SSE connection mid-task can resume the stream without re-executing
  the agent. Introduces an in-memory `TaskEventBus` (pluggable via
  `A2XAgentOptions.taskEventBus`) that fans events out from `message/stream`
  to any number of resubscribers. Resubscribing to a task in terminal state
  replays a single status-update event with the final state and ends; for
  an unknown task the method returns `TaskNotFoundError`. Closes [#39](https://github.com/planetarium/a2x/issues/39).

### Patch Changes

- [#42](https://github.com/planetarium/a2x/pull/42) [`47add77`](https://github.com/planetarium/a2x/commit/47add777b85f56980cb27c9722f8dc42b804bef6) Thanks [@ost006](https://github.com/ost006)! - fix(transport): terminate server-side execution when SSE client disconnects

  Previously, when an SSE client disconnected mid-task, the server continued executing the full LLM loop (up to 25 calls) because `createSSEStream`'s cancel callback was empty and the built-in HTTP server never listened for `req.on('close')`. Now the cancel callback calls `.return()` on the source generator, `AgentExecutor`'s finally block aborts its internal controller (which PR [#22](https://github.com/planetarium/a2x/issues/22) already wired through to the LLM provider), and the built-in server cancels the stream reader on TCP close. Closes [#20](https://github.com/planetarium/a2x/issues/20).

## 0.4.0

### Minor Changes

- [#38](https://github.com/planetarium/a2x/pull/38) [`4b8757b`](https://github.com/planetarium/a2x/commit/4b8757ba0336555fc6ab0e77e37526cb4ec4c971) Thanks [@ost006](https://github.com/ost006)! - Wire the missing JSON-RPC methods for push notification config management.

  `DefaultRequestHandler` now routes the following methods to
  `PushNotificationConfigStore` when one is injected:

  - `tasks/pushNotificationConfig/set`
  - `tasks/pushNotificationConfig/get`
  - `tasks/pushNotificationConfig/list`

  Both A2A v0.3 (`{ id, pushNotificationConfigId }`) and v1.0 (`{ taskId, id }`)
  wire shapes are normalized by the handlers, mirroring the existing
  `tasks/pushNotificationConfig/delete` behavior. Agents that do not inject a
  `pushNotificationConfigStore` continue to receive
  `PushNotificationNotSupportedError` (-32003) as before.

  `tasks/resubscribe` and `agent/authenticatedExtendedCard` remain unimplemented
  and will be addressed in a follow-up phase.

## 0.3.0

### Minor Changes

- [#36](https://github.com/planetarium/a2x/pull/36) [`b57f711`](https://github.com/planetarium/a2x/commit/b57f711eca332fad3d64c09d1beeca7165d9fae1) Thanks [@ost006](https://github.com/ost006)! - Bundle a Guides directory (`docs/`) with the npm package. The new tree under
  `node_modules/@a2x/sdk/docs/` contains progressive-disclosure guides (Getting
  Started → Agent → Client → Advanced) plus a `manifest.json` describing the
  navigation. The `a2x-web` documentation site consumes these files at build
  time so guides stay version-locked to the SDK that introduced them.

  No API surface change; this release only enlarges the published tarball.

## 0.2.0

### Minor Changes

- [#28](https://github.com/planetarium/a2x/pull/28) [`cc6b1eb`](https://github.com/planetarium/a2x/commit/cc6b1eb3bf0d77a52f5c46a4892aaae57c9f85b1) Thanks [@ost006](https://github.com/ost006)! - Emit and consume OAuth2 Device Code flow as a non-standard extension on A2A
  v0.3 AgentCards.

  Previously, `OAuth2DeviceCodeAuthorization.toV03Schema()` returned `null` and
  the scheme was silently stripped from v0.3 cards — headless/CLI clients that
  rely on device code flow could not negotiate against v0.3 peers even though
  both sides already supported it internally.

  The scheme now emits `oauth2.flows.deviceCode` on v0.3 cards (mirroring the
  v1.0 shape) and `normalizeOAuth2FlowsV03()` consumes it. OpenAPI 3.0 does
  not standardize this flow, so a warning is still logged on emission and
  strict third-party v0.3 parsers may ignore the unknown flow.

## 0.1.1

### Patch Changes

- [#14](https://github.com/planetarium/a2x/pull/14) [`91ba909`](https://github.com/planetarium/a2x/commit/91ba90916aac0a0299eaa876df458230afca64da) Thanks [@ost006](https://github.com/ost006)! - Add comprehensive README for npm package page
