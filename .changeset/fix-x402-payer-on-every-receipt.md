---
'@a2x/sdk': patch
---

Every x402 settlement receipt now carries the `payer` address, including
failure rows.

Closes [#143](https://github.com/planetarium/a2x/issues/143) (fix 2 of 4).

**Why.** x402-v1 §5.3.2 requires the payer wallet address on every
receipt the merchant emits, success or failure. Before, the SDK
populated `payer` only on success rows; failure receipts went out
without it, breaking spec-conformant downstream auditors.

**Fix.** `payer: string` is now required on the internal X402Receipt
type, and both the blocking and streaming executor paths thread the
payer address into every receipt — including the failure-row branch
that previously omitted it.
