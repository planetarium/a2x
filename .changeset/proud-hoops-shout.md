---
"@a2x/sdk": patch
---

Preserve the facilitator's settled `amount` on x402 settlement receipts.

`X402Context.settle()` trimmed the facilitator response into the wire receipt and dropped the x402 V2 `amount` field, so the settled amount never reached `x402.payment.receipts` on the task's final message. `X402SettleResponse` now carries an optional `amount`, and `settle()` passes the facilitator's value through on the success receipt and on failure receipts built from a structured `success: false` response body. (Non-2xx settlement failures surface as errors thrown by `@x402/core`, which drops `amount` before the SDK sees it — those failure receipts cannot carry the field.) For the `exact` scheme this matches the offered amount; under usage-based schemes it is the metered charge and is the payer's only record of what they were actually charged. V1 facilitators never report it, so the field stays absent there.
