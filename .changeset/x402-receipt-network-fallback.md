---
"@a2x/sdk": patch
---

x402: settle receipts fall back to the matched requirement's network when the payload cannot name one.

`payloadNetwork` returns `''` for a V2 payload with no `accepted` echo (required by the type, but a wire peer can omit it at runtime), and `X402Context.settle` wrote that empty string into the receipt's `network` field. Both receipt paths (success and settle-failure) now fall back to `classified.requirement.network`, which `classify` has already encoded for the offered generation, so the receipt names the network in the right per-generation form.
