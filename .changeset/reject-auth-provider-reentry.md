---
'@a2x/sdk': patch
---

Reject same-client authenticated re-entry from `AuthProvider` callbacks instead of waiting forever on the callback's own initialization or refresh promise.
