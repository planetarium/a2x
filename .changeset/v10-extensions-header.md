---
"@a2x/sdk": patch
---

Servers now accept the A2A v1.0 `A2A-Extensions` extension-activation header (spec a2a-v1.0 §3.2.6) in addition to the v0.3-era `X-A2A-Extensions` spelling. Previously a strictly conformant v1.0 client activating a required extension via `A2A-Extensions` was rejected with `-32600`. The required-extension rejection message now names the header matching the server's `protocolVersion`. (#193)
