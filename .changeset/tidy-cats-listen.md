---
"@a2x/sdk": patch
---

Limit JSON-RPC request bodies handled by the standalone Node.js listener to 1 MiB and return HTTP 413 for oversized payloads.
