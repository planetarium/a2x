---
"@a2x/sdk": minor
---

Add x402 Embedded Flow support (mid-execution payment via artifacts).

`X402PaymentExecutor` now supports the Embedded Flow from a2a-x402 v0.2 in
addition to the existing Standalone gate. The inner agent can yield a
`paymentRequired` event mid-run; the executor stashes the paused generator,
emits the challenge on a task artifact, transitions the task to
`input-required`, and resumes the same generator once the client
resubmits a signed payload.

New API surface:

- `paymentRequiredEvent({ accepts?, embeddedObject?, artifactName?, ... })`
  — typed builder for the new `{ type: 'paymentRequired' }` AgentEvent
  variant.
- `X402PaymentExecutorOptions.resolveAccepts(ctx)` — dynamic pricing
  hook. Consulted when the event omits inline `accepts`.
- `X402PaymentExecutorOptions.accepts` is now optional — omit to skip the
  gate and rely exclusively on Embedded charges.
- `getEmbeddedX402Challenges(task)` — parse pending Embedded challenges
  off a task's artifacts. Recognizes the bare SDK shape and any
  `x402PaymentRequiredResponse`-shaped object nested inside a
  higher-level wrapper (AP2 `CartMandate` etc.).
- `X402ClientOptions.onEmbeddedPaymentRequired` callback, plus a
  `maxPaymentHops` cap (default 8). `X402Client.sendMessage` now loops
  over every challenge the merchant emits instead of stopping after the
  gate.
- `X402_EMBEDDED_ARTIFACT_NAME` / `X402_EMBEDDED_DATA_KEY` constants for
  callers that parse artifacts by hand.

The Standalone gate path, its error codes, and `X402Client` defaults
remain backwards-compatible. Internal rename: `__internal.attachReceipt`
→ `__internal.attachReceipts` (accepts an array; gate + embedded
receipts now stack).
