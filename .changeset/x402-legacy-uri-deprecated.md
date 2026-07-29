---
"@a2x/sdk": patch
---

x402: mark `X402_EXTENSION_URI` `@deprecated` as an AgentCard-advertised URI.

New deployments should advertise `X402_FOUNDATION_EXTENSION_URI` — the URI the x402 Foundation A2A transport mandates. Registering the legacy v0.2 URI from a client to pin the V1 wire generation (`extensions: [X402_EXTENSION_URI]`) remains supported and is the documented V1 opt-out; only advertising it on a card is deprecated.
