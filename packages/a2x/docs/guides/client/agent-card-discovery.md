# Agent Card Discovery

The AgentCard is how one A2A participant describes itself to another. When you hand `A2XClient` a `.well-known/agent.json` URL, it fetches this card and uses it for every subsequent call.

## What's on the card

Useful fields at a glance:

- `name`, `description` — human-readable identity.
- `url` or `supportedInterfaces[].url` — where to send JSON-RPC. Field location depends on protocol version; A2X normalizes this for you.
- `capabilities.streaming` — whether `message/stream` is supported.
- `skills[]` — declared capabilities (ids, tags).
- `securityRequirements` / `securitySchemes` — what auth the agent expects.
- `protocolVersion` — the A2A version the card was issued under (`0.3` or `1.0`).

## Resolving a card manually

```ts
import { A2XClient } from '@a2x/sdk/client';

const client = new A2XClient('https://agent.example.com/.well-known/agent.json');
const resolved = await client.resolveAgentCard();

console.log(resolved.version);  // '0.3' | '1.0'
console.log(resolved.card);     // parsed AgentCard for that version
```

`ResolvedAgentCard` is the union of "which version we ended up with" plus "the parsed card". Use it when you need to branch on version or inspect declared skills before calling the agent.

## Version negotiation

A2A has two spec versions in the wild. You don't pick — the remote agent declares, and the client adapts:

- If the card declares `protocolVersion: '1.0'`, `A2XClient` uses the v1.0 endpoints and shapes.
- If it declares `0.3` (or omits the field), the client uses v0.3.

You can force a preference:

```ts
const client = new A2XClient(url, { preferredVersion: '1.0' });
```

When the remote supports both, this picks your preference; when it only supports one, the client falls back gracefully.

## Calling non-A2X agents

`A2XClient` is a protocol-level client, not an A2X-only one. Any agent whose AgentCard is valid A2A works, regardless of what SDK produced it. The only thing that changes is the URL you pass.

## Caching and refreshing

`A2XClient` caches the card after the first fetch. If the remote agent rolls out a new version, drop the client and construct a new one, or use `resolveAgentCard({ force: true })` to bypass the cache.

For long-running processes you can add a periodic refresh yourself — the card is cheap to refetch.
