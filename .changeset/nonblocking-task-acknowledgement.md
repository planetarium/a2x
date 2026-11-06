---
'@a2x/sdk': patch
---

Honor nonblocking message sends (`blocking: false`, or v1.0 `returnImmediately: true`) by acknowledging a persisted task before its unary executor finishes. Keep execution independent of the response connection, persist outcomes and background failures for later lookup, and preserve explicit cancellation and existing blocking defaults.
