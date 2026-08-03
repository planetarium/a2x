---
"@a2x/sdk": minor
---

x402 V2 `payment-required` envelopes can now carry the top-level `extensions` field. `X402RequestPaymentInput` (and therefore `x402RequestPayment`, `buildX402PaymentRequiredMetadata`, and `X402Context.requestPayment`) accepts an `extensions` object that `encodePaymentRequiredV2` emits verbatim; it is a no-op under `x402Version: 1`, whose envelope has no such field. This is how a merchant advertises facilitator capabilities such as `eip2612GasSponsoring` — without it, `@x402/evm` payers fall back to a gas-paying on-chain approval even when the facilitator would sponsor a gasless permit. The new client-side reader `getX402PaymentExtensions(task)` returns the advertised object so callers driving signing manually can hand it to `@x402/core`'s `PaymentPayloadContext`. (#197)
