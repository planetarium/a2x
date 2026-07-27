---
"@a2x/sdk": minor
---

x402: speak both protocol generations (V1 and V2) with automatic negotiation.

A2X now implements the x402 Foundation A2A transport (V2 — CAIP-2 networks, `amount`, hoisted top-level `resource`, and a `PaymentPayload` that echoes the chosen requirement under `accepted`) alongside the existing V1 envelopes. The foundation extension URI is generation-neutral, so generation is an a2x negotiation profile: the server emits `X402ContextOptions.defaultGeneration` (**V1** by default — the migration-safe choice; the legacy v0.2 URI, activated on its own, pins V1) and clients sign whichever generation they receive. Deployments whose clients all speak V2 opt in with `new X402Context({ defaultGeneration: 2 })` and advertise the foundation URI. Advertising both `X402_FOUNDATION_EXTENSION_URI` and `X402_EXTENSION_URI` lets V1-only clients interoperate during a migration window — a2x's request handler treats them as an activation family (an a2x-server-specific relaxation of A2A's `required` rule).

New exports from `@a2x/sdk/x402`: `X402_FOUNDATION_EXTENSION_URI`, `X402_EXTENSION_URIS`, `X402_SUPPORTED_VERSIONS`, `X402_DEFAULT_GENERATION`, `detectGeneration`, `isSupportedVersion`, `x402PinnedGeneration`, `isX402ExtensionUri`, `X402PeerMissingError`, and the V1/V2 requirement/payload/response type variants. `X402ContextOptions` gains `defaultGeneration`; `X402StoreEntry` gains `offeredGeneration`.

Three behavior changes worth knowing about when upgrading:

- **Server-side validation now enforces `x402Version` on submitted payloads**, per x402-v1 §5.2 ("All fields are required"; `x402Version` is a `number` that "must be 1"). Previously a submission was matched on `scheme`/`network` alone and the version was never inspected, so a non-conformant client that omitted the field — or sent it as the string `"1"` — was accepted. Such submissions now fail with `invalid_x402_version`. Payloads produced by the `x402` package, `@x402/core`, or a2x itself always carry the numeric field and are unaffected; only hand-rolled or third-party clients that skipped it are.
- `resolveFacilitator` no longer throws when the facilitator rejects a payment. `@x402/core` raises `VerifyError`/`SettleError` on a non-2xx response even when the body is a usable `{isValid:false}` / `{success:false}`; the SDK now unwraps that back into a normal negative result. Agents that wrapped `facilitator.verify()` in `try`/`catch` to detect failures should branch on `isValid` / `success` instead — their catch block will no longer fire. Genuine transport/schema errors still propagate.
- `A2XClient` may stop sending the legacy v0.2 URI in `X-A2A-Extensions`. When the resolved AgentCard advertises `X402_FOUNDATION_EXTENSION_URI`, the client upgrades to it and drops the v0.2 URI it auto-seeded (a URI the caller registered explicitly is never dropped). a2x servers accept either via the activation family; a third-party server that marks the v0.2 URI `required` while also advertising the foundation URI would need the caller to pin v0.2 explicitly via `extensions`.

Fixes a client-side budget-cap bug: `maxAmount` enforcement read the V1-only `maxAmountRequired` field, which is absent on V2 requirements — the cap is now read through a generation-agnostic accessor.

**Breaking (peer dependencies + types).** The signing/facilitator runtime moved from `x402` to `@x402/core` + `@x402/evm` (both optional peers). Install `@x402/core @x402/evm viem` instead of `x402 viem` when enabling x402. Because the peers load lazily, forgetting this is not caught at install or startup — it surfaces on the first real payment as `X402PeerMissingError`, which names the packages to install (the failed load isn't cached, so the next attempt succeeds once they are).

The `X402PaymentRequirements` type is now a V1|V2 union, so code reading requirement fields directly should use the exported accessors (`requirementAmount`, `requirementNetwork`, `requirementScheme`, `requirementPayTo`) or narrow on `x402Version`. `X402SettleResponse.payer` is now optional (x402 V2 marks it optional and the SDK never fabricates a placeholder), and `X402PaymentRequiredResponse.x402Version` widened from the literal `1` to `1 | 2`. `X402Accept` — the type agents author their offerings with — is unchanged, so agents that define offerings and drive `X402Context` need no code change.

Per AGENTS.md semver ("pre-1.0, still follow semver"), this breaking change ships as a `minor` because the package is pre-1.0 (0.x) — 0.x minors may carry breaking changes.
