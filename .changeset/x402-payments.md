---
'@a2x/sdk': minor
---

Add a2a-x402 v0.2 payment support via a new `@a2x/sdk/x402` subpath.

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
