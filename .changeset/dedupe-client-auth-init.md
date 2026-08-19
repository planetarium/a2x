---
"@a2x/sdk": patch
---

Deduplicate concurrent AgentCard resolution, authentication initialization, and credential refresh so shared clients atomically publish successful credential generations, wait for newer in-flight refreshes, and close rejected SSE responses before retrying.
