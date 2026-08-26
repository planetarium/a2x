---
'@a2x/sdk': minor
---

Require MerchantGate callers to choose buffered or progressive delivery timing, serialize publication against lapse and session deadlines with atomic lifecycle-store primitives, terminally close unpublished batch attempts before releasing canceled claims, retain uncertain cancellations for reconciliation, and settle partial work that fails after content may have been delivered.
