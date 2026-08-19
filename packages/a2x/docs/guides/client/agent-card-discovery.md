# Agent Card Discovery

The AgentCard is how one A2A participant describes itself to another. When you hand `A2XClient` a `.well-known/agent.json` URL, it fetches this card and uses it for every subsequent call.

## What's on the card

Useful fields at a glance:

- `name`, `description` — human-readable identity.
- `url` — the v0.3 JSON-RPC endpoint.
- `supportedInterfaces[]` — v1.0 transport endpoints. `A2XClient` requires an entry whose `protocolBinding` is `JSONRPC`.
- `capabilities.streaming` — whether `message/stream` is supported.
- `skills[]` — declared capabilities (ids, tags).
- `securityRequirements` / `securitySchemes` — what auth the agent expects.
- A recognized top-level `protocolVersion` identifies the version when present; v1.0 commonly declares a version per `supportedInterfaces[]` entry instead.

## Resolving a card manually

```ts
import { A2XClient, resolveAgentCard } from '@a2x/sdk/client';

const resolved = await resolveAgentCard(
  'https://agent.example.com/.well-known/agent.json',
);
const client = new A2XClient(resolved.card);

console.log(resolved.version);  // '0.3' | '1.0'
console.log(resolved.card);     // parsed AgentCard for that version
```

`ResolvedAgentCard` is the union of "which version we ended up with" plus "the parsed card". Use it when you need to branch on version or inspect declared skills before calling the agent.

## Version negotiation

A2A has two spec versions in the wild. You don't pick — the remote agent declares, and the client adapts:

- A recognized top-level `protocolVersion` is authoritative (notably v0.3 cards).
- Otherwise, a non-empty v1.0 `supportedInterfaces` array selects v1.0; a top-level `url` selects v0.3.

For v1.0, the card must advertise a `JSONRPC` interface. Cards that expose only gRPC or HTTP+JSON are rejected before authentication or transport begins. There is no `preferredVersion` client option; use the card document published for the desired protocol when a peer exposes multiple version-specific cards.

## Calling non-A2X agents

`A2XClient` is a protocol-level client, not an A2X-only one. It works with A2A agents produced by any SDK when their card advertises a supported JSON-RPC interface.

## Caching and refreshing

`A2XClient` caches the card after the first successful resolution. Concurrent first calls on one client share the same in-flight discovery. A card that fails endpoint or parser validation is not cached, so the next call retries discovery.

If the remote agent rolls out a new version, call `resolveAgentCard(url)` again and construct a new client from the returned card. The standalone resolver does not cache.

For long-running processes you can add a periodic refresh yourself — the card is cheap to refetch.
