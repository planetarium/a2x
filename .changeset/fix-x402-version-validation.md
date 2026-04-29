---
'@a2x/sdk': patch
---

`signX402Payment` now rejects unsupported `x402Version` values up front
with a typed `X402InvalidVersionError` instead of crashing inside the
underlying `createPaymentHeader` call.

Closes [#143](https://github.com/planetarium/a2x/issues/143) (fix 3 of 4).

**Why.** x402-v1 §9 lists `invalid_x402_version` as a defined error
code. The SDK never surfaced it: a non-1 `x402Version` in a payment
requirement crashed inside `x402.createPaymentHeader` with an opaque
error message, leaving callers no way to handle the version mismatch
without parsing strings.

**Fix.** New `X402InvalidVersionError` (exported alongside the other
`X402*Error` classes) is thrown from `signX402Payment` when the
requirement's `x402Version` is not `1`. The error carries the spec
code `invalid_x402_version` (also added to `X402_ERROR_CODES` as
`INVALID_X402_VERSION`) so callers can branch on it.
