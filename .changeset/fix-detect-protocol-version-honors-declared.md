---
'@a2x/sdk': patch
---

Fix `detectProtocolVersion` (and therefore `A2XClient`) to honor the AgentCard's
declared top-level `protocolVersion` field before falling back to shape
heuristics. Per `a2a-v0.3.0.json`, `protocolVersion` is required on v0.3 cards;
per `a2a-v1.0.0.json`, it does not exist at the top level. The previous
shape-only check misclassified v0.3 agents that legally advertise
`supportedInterfaces` for additional transports as v1.0, which skipped the v0.3
wire transform and shipped message parts without the required `kind`
discriminator. The server then dropped the parts and rejected the request.
