---
'@a2x/sdk': minor
---

x402: remove SDK-owned payment flow; ship stateless helpers only

The SDK no longer owns the x402 payment flow. `x402PaymentHook`,
`readX402Settlement`, `X402_DOMAIN`, the `inputRoundTripHooks`
`AgentExecutor` option, and every `InputRoundTrip*` type are removed.
The `_a2x.inputRoundTrip` bookkeeping that previously leaked onto the
wire on every `input-required` response is gone with them.

The agent now owns the entire payment lifecycle inside
`BaseAgent.run()`, calling `facilitator.verify()` and `facilitator.settle()`
directly. New stateless helpers expose each spec mechanic as one step
the agent composes:

- `parseX402PaymentSubmission(message)` — read x402 fields off an
  incoming message.
- `pickX402Requirement(payload, requirements)` — find the requirement
  matching the submitted network + scheme.
- `validateX402PayloadShape(payload, requirement)` — local checks
  (payTo, amount cap, EVM shape) returning an array of issues so the
  caller decides which are fatal.
- `normalizeX402Accept(accept)` — apply default scheme/mimeType/timeout.
- `buildX402PaymentRequiredMetadata` / `buildX402PaymentCompletedMetadata`
  / `buildX402PaymentFailedMetadata` / `buildX402PaymentVerifiedMetadata`
  — pure metadata builders for each lifecycle state.

The `request-input` AgentEvent drops its `domain` and `payload` fields;
`done` and `error` events accept an optional `metadata` field that the
executor merges onto the final status message. `InvocationContext`
gains a `message` field carrying the current turn's incoming `Message`
so agents can detect resume conditions by inspecting message metadata
directly.

Wire format is unchanged — every `x402.payment.*` metadata key, status
value, and error code is bit-for-bit identical. Existing A2A clients
keep working without modification. See
`docs/guides/advanced/migration-x402-v2.md` for the migration steps.
