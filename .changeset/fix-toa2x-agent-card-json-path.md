---
'@a2x/sdk': patch
---

`toA2x()` and `createA2xRequestListener()` now serve the AgentCard at both
`/.well-known/agent.json` and `/.well-known/agent-card.json`.

Closes [#142](https://github.com/planetarium/a2x/issues/142) (fix 3 of 5).

**Why.** The SDK's own `resolveAgentCard()` tries the modern
`/.well-known/agent-card.json` first and falls back to the v0.3
`/.well-known/agent.json`. The Next.js samples already expose both routes,
but plain `toA2x()` users only got the legacy path — a client that hit the
modern path first received a 404 and only saw the card after a fallback
round trip (or, with strict client configurations, not at all).

**Fix.** Both well-known paths route to `handler.getAgentCard()` and return
the same body. No other behavior change.
