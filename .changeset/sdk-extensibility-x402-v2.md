---
'@a2x/sdk': minor
---

Redesign the x402 surface around input-required round-trips. The
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
