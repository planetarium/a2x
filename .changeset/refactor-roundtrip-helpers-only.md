---
'@a2x/sdk': minor
---

x402: remove SDK-owned payment flow; ship stateless helpers + X402Context façade only; move x402 surface to dedicated subpath

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
import { X402Context, signX402Payment } from '@a2x/sdk';

// After
import { X402Context, signX402Payment } from '@a2x/sdk/x402';
```

`A2XClientX402Options` (the constructor-option type on `A2XClient`)
stays on the main entry — it's a client-config type, not an x402-feature
import.

Wire format is unchanged — every `x402.payment.*` metadata key, status
value, and error code is bit-for-bit identical. Existing A2A clients
keep working without modification. See
`docs/guides/advanced/migration-x402-v2.md` for the migration steps.
