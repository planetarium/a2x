---
'@a2x/sdk': patch
---

`A2XClient` now decides x402 outcomes on the **latest** receipt plus the
task state, recognizes the server-side `retryOnFailure` re-prompt, and
adds an opt-in `maxRetries` for automatic re-sign on the same task.

Closes [#143](https://github.com/planetarium/a2x/issues/143) (fix 4 of 4).

**Why.** The pre-fix client scanned the full receipt history and threw
on *any* historical failure, even when the merchant had since prompted
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
