---
"@a2x/sdk": minor
---

x402: speak both protocol generations (V1 and V2) with automatic negotiation.

A2X now implements the x402 Foundation A2A transport (V2 — CAIP-2 networks, `amount`, hoisted top-level `resource`, and a `PaymentPayload` that echoes the chosen requirement under `accepted`) alongside the existing V1 envelopes, and negotiates the generation per interaction via extension-URI activation. Servers emit the generation the client's activated extension proves it speaks (falling back to `X402ContextOptions.defaultGeneration`, V1 by default); clients activate the newest generation the AgentCard advertises and sign whichever generation they receive. Advertising both `X402_V2_EXTENSION_URI` and `X402_EXTENSION_URI` lets V1-only and V2-only clients interoperate during a migration window — the two URIs form an activation family.

New exports from `@a2x/sdk/x402`: `X402_V2_EXTENSION_URI`, `X402_EXTENSION_URIS`, `X402_SUPPORTED_VERSIONS`, `X402_DEFAULT_GENERATION`, `detectGeneration`, `isSupportedVersion`, `x402GenerationForUri`, `isX402ExtensionUri`, and the V1/V2 requirement/payload/response type variants. `X402ContextOptions` gains `defaultGeneration`; `X402StoreEntry` gains `offeredGeneration`.

Fixes a client-side budget-cap bug: `maxAmount` enforcement read the V1-only `maxAmountRequired` field, which is absent on V2 requirements — the cap is now read through a generation-agnostic accessor.

**Breaking (peer dependencies).** The signing/facilitator runtime moved from `x402` to `@x402/core` + `@x402/evm` (both optional peers). Install `@x402/core @x402/evm viem` instead of `x402 viem` when enabling x402. The `X402PaymentRequirements` type is now a V1|V2 union, so code reading requirement fields directly should use the exported accessors (`requirementAmount`, `requirementNetwork`, `requirementScheme`, `requirementPayTo`) or narrow on `x402Version`.
