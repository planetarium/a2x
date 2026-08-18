---
"@a2x/sdk": patch
---

Emit the required `final` field on every v0.3 task status update.

Non-final updates carry `final: false`; interaction-ending completed, failed, input-required, auth-required, and terminal resubscribe updates carry `final: true`. The v1.0 wire format remains unchanged.
