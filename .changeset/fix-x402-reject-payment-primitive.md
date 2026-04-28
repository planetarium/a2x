---
'@a2x/sdk': patch
---

Add `rejectX402Payment(task)` primitive and let `onPaymentRequired`
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
