---
'@a2x/sdk': minor
---

Remove the `version` parameter from `A2XAgent.getAgentCard()` and
`DefaultRequestHandler.getAgentCard()`. The card is now always rendered in the
agent's configured `protocolVersion` — the same wire format the server actually
speaks.

Closes [#133](https://github.com/planetarium/a2x/issues/133).

**Why.** The server's wire format is fixed at construction time (the
`protocolVersion` chosen on `new A2XAgent({...})` selects a single
`responseMapper`). Letting `getAgentCard(version)` render a card in a different
version published a contract the server could not honor: response shapes
(`TASK_STATE_COMPLETED` vs `'completed'`), role/part encoding (`ROLE_USER` vs
`'user'`, `kind` discriminator presence), and `pushNotificationConfig/{set,delete}`
param shape are all bound to the configured version. A v1.0 agent serving a
v0.3 card silently broke every call from a conforming v0.3 client, because
`A2XClient.detectProtocolVersion()` honors the card's declared version
absolutely.

**Breaking — removals.**
- `A2XAgent.getAgentCard(version?)` — the `version` parameter is removed.
- `DefaultRequestHandler.getAgentCard(version?)` — the `version` parameter is
  removed.
- The `?version=` query string on `GET /.well-known/agent.json` (built-in
  `to-a2x` HTTP server) is no longer honored.

In-tree callers that already passed no argument (`samples/express`,
`samples/nextjs`, `samples/nextjs-skill`, `samples/nextjs-x402`) are
unaffected. Callers that previously did `getAgentCard('0.3')` against a v1.0
agent (or vice versa) were creating the foot-gun this fix removes — the
correct migration is to construct a separate `A2XAgent` with the desired
`protocolVersion`:

```ts
// Before — silently broken: card said v0.3, wire still spoke v1.0
const card03 = a2xAgent.getAgentCard('0.3');

// After — one agent per wire format
const a2xAgentV03 = new A2XAgent({ taskStore, executor, protocolVersion: '0.3' });
const card03 = a2xAgentV03.getAgentCard();
```
