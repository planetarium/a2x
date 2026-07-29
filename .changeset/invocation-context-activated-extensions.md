---
"@a2x/sdk": minor
---

Expose the client's activated A2A extensions to agents via `InvocationContext.activatedExtensions`.

The extension URIs a client sends in the `X-A2A-Extensions` header are now threaded from the request handler through the executor and runner onto `InvocationContext.activatedExtensions`, so agents can branch on what the client activated. `AgentExecutor.execute` / `executeStream` accept an optional `{ activatedExtensions }` argument to carry it. All additions are optional and backward-compatible. The x402 extension uses this for its compatibility check: an x402 V2 server refuses a client whose activation declares it V1-only.
