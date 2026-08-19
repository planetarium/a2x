---
"@a2x/sdk": patch
---

Reject v1.0 AgentCards that advertise no JSON-RPC interface instead of posting JSON-RPC payloads to an unrelated transport binding, while keeping a failed URL discovery retryable.
