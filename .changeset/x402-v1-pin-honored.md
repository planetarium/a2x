---
"@a2x/sdk": patch
---

x402: honor an explicit V1 pin when the agent advertises the foundation URI.

A client that deliberately pins V1 — `new A2XClient(url, { x402: { signer }, extensions: [X402_EXTENSION_URI] })`, the documented way for tooling that only decodes V1 envelopes — was silently handed V2 by any agent that advertises `X402_FOUNDATION_EXTENSION_URI` and opted into `defaultGeneration: 2`.

Two halves of the same mistake, both fixed:

- `A2XClient` added the foundation URI *alongside* the caller's v0.2 URI. It kept the URI but destroyed the pin, because the server only reads v0.2 as "pin V1" when the foundation URI is absent. The client now leaves a caller-registered activation set untouched; the x402 activation family means the v0.2 URI alone still satisfies an agent that requires the foundation URI.
- `pickEmissionGeneration` treated "both URIs activated" as a dual-capable client and emitted `defaultGeneration`. That is fail-open: activating the V1 pin proves the client decodes V1, while neither URI proves it decodes V2 (the foundation URI is generation-neutral). The v0.2 URI now pins V1 whenever it is present. A client that prefers V2 activates the foundation URI alone — which is what `A2XClient` does once a card advertises it.

The bug was unreachable until an agent advertised the foundation URI, so no released configuration is affected.

The URI→generation mapping now lives in exactly one place, `x402PinnedGeneration` — `BaseX402Context.pickEmissionGeneration` reads it instead of re-deriving the rule. Re-deriving it is what let the two halves drift apart. `x402PinnedGeneration` was exported by the previous release-in-progress but unused by the SDK itself; it is now the single source of truth and has direct test coverage.
