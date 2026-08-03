---
"@a2x/sdk": minor
---

Native support for the x402 V2 `upto` scheme (usage-based payments), where the payer signs a Permit2 authorization **up to** a maximum and the merchant settles only the metered charge — bill by LLM token consumption instead of a flat per-call fee. (#199)

- `X402Accept.scheme` now types `'exact' | 'upto' | (string & {})` instead of pinning `'exact'`.
- `validateX402PayloadShape` dispatches on the matched requirement's scheme: `exact` keeps the EIP-3009 checks, `upto` validates the Permit2 shape (`permit2Authorization` + `signature` present, `witness.to` bound to `payTo`, `permitted.token` matching the asset, a positive in-range `permitted.amount`, and a payer `from`). Unrecognized payloads no longer report the misleading "Non-EVM payloads are not yet supported" — a Permit2 payload is an EVM payload.
- `BaseX402Context.settle(ctx, classified, { amountAtomic })` settles a metered amount. The SDK clamps it down to the minimum of the metered value, the offered amount, and the payer's signed authorization cap, using BigInt comparison and writing the right field for the requirement's wire version (`amount` under V2, `maxAmountRequired` under V1) — a merchant metering bug can therefore only ever undercharge. `"0"` is a legal charge; a negative or non-integer amount throws.
- Shape validation moved behind a `protected validatePayloadShape(payload, requirement)` hook on `BaseX402Context`, called by `classify` **before** the store records `status: 'failed'`, so a subclass teaching the pipeline a new scheme no longer has to repair the store afterwards.
- `payer` backfill is now scheme-agnostic: receipts fill it from `permit2Authorization.from` as well as `authorization.from`. `parseX402PaymentSubmission` exposes `payer` and `permit2Authorization`, and the new `extractX402Payer(payload)` reads it from either shape.
- `X402EntryReceipt` gains an optional `amount` — the settled charge, persisted on the store entry. Under a usage-based scheme it is the key reconciliation datum and is not recoverable from `entry.accepts`, which holds the authorized maximum.
- The wire codecs no longer synthesize an EIP-712 domain into `extra` for non-`exact` schemes. That default is `exact`/EIP-3009-specific, and emitting it would have shadowed the `facilitatorAddress` an `upto` requirement must carry.
- New exported types: `X402Permit2Authorization`, `X402UptoEvmPayload`, `X402ExactEvmPayload`.

Client signing registers `@x402/evm`'s `UptoEvmScheme` alongside the exact scheme, so an `upto` offer can be signed. **The default selector still never auto-picks one** — signing `upto` authorizes spending up to the maximum at the merchant's discretion, a broader consent than `exact`, so it stays opt-in via the new `allowUpto` option on `SignX402PaymentOptions` and `A2XClient`'s `x402` config (a payable `exact` offer always wins), or via an explicit `selectRequirement`.

`upto` requires `@x402/evm` >= 2.19, which the existing peer range (`>=2.19.0 <3`) already mandates — no peer-range change.
