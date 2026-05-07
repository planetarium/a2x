---
"@a2x/sdk": patch
---

Remove the redundant `@a2x/sdk/x402` subpath. All x402 symbols (`X402_EXTENSION_URI`, `x402RequestPayment`, `x402PaymentHook`, `readX402Settlement`, `signX402Payment`, `rejectX402Payment`, `getX402Receipts`, `getX402PaymentRequirements`, `getX402Status`, `X402_DOMAIN`, `resolveFacilitator`, `X402_DEFAULT_FACILITATOR_URL`, `X402PaymentRequiredError`, and the rest) remain available from the package root `@a2x/sdk` — only the duplicate subpath import is gone. Migration: replace `from '@a2x/sdk/x402'` with `from '@a2x/sdk'`.
