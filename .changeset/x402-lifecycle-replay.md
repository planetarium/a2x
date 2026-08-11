---
'@a2x/sdk': patch
---

Make `MerchantGate` replay handling lifecycle-aware, retain completed receipts until expiry, skip verification for known claimed attempts, and keep indeterminate settlement attempts claimed for reconciliation.
