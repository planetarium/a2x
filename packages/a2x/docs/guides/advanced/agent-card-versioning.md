# AgentCard v0.3 vs v1.0

A2A has two spec versions in active use. The **AgentCard** — the JSON your agent serves at `/.well-known/agent.json` — differs in shape between them. A2X hides most of the difference behind a single `A2XAgent` instance that can emit either version.

You usually don't pick. `toA2x()` and `DefaultRequestHandler.getAgentCard()` default to **v1.0**. If a client specifically asks for v0.3 (via `Accept` header or protocol negotiation), A2X transparently emits the v0.3 shape from the same underlying state.

## The key differences

| Concept | v0.3 | v1.0 |
|---|---|---|
| Where the endpoint URL lives | top-level `url` | `supportedInterfaces[].url` |
| Transport selection | `preferredTransport` string | `supportedInterfaces[].protocolBinding` |
| Security declarations | `security` array + `securitySchemes` map | `securityRequirements` array + `securitySchemes` map |
| Multiple transports on one agent | not supported | supported via multiple `supportedInterfaces` |

A2X models everything internally in the v1.0 shape and down-converts to v0.3 on demand. This means:

- Every declaration you make on `A2XAgent` (skills, security, default URL) works for both versions.
- Consumers on either spec see a valid card.
- You don't write version branches in your own code.

## Emitting a specific version

```ts
const v10 = a2xAgent.getAgentCard();          // v1.0 (default)
const v03 = a2xAgent.getAgentCard('0.3');      // v0.3 explicit
```

Both paths are pre-wired when you use `toA2x()` or `DefaultRequestHandler` — callers negotiating over HTTP get the version they asked for.

## When this matters to you

Three scenarios where you actually need to care:

### 1. Deploying alongside legacy v0.3 clients

If you have CLI tools or third-party agents still pinned to v0.3, they read `url` and `preferredTransport` — not `supportedInterfaces`. A2X's v0.3 emission handles this automatically.

### 2. Emitting a non-standard scheme on v0.3

OAuth 2.0 Device Code is a v1.0-native security flow. A2X extends it onto v0.3 cards as a non-standard extension so headless clients can still negotiate it. See [Protocol Extensions](./extensions.md) for details.

### Advertising the authenticated extended card

When you call `a2xAgent.setAuthenticatedExtendedCardProvider(...)`, A2X flips the version-specific capability flag on the base card automatically:

- v0.3: top-level `supportsAuthenticatedExtendedCard: true`
- v1.0: `capabilities.extendedAgentCard: true`

Conforming clients read this to decide whether to call `agent/getAuthenticatedExtendedCard`. You don't set either flag by hand — registering the provider is the only signal you need. See [Authenticated Extended AgentCard](./extended-agent-card.md).

### 3. Multi-transport agents

If you plan to expose JSON-RPC over HTTP **and** another transport (e.g. gRPC), only v1.0 expresses this cleanly. Legacy v0.3 consumers will only see the first/primary interface.

## Consuming: what `A2XClient` does

On the client side, `A2XClient` reads the remote card's `protocolVersion` field (or infers v0.3 when absent) and routes calls accordingly. You usually don't need to pick a version yourself:

```ts
const resolved = await client.resolveAgentCard();
console.log(resolved.version);   // '0.3' | '1.0'
console.log(resolved.card);      // the parsed card for that version
```

To force a preference when the remote supports both:

```ts
const client = new A2XClient(url, { preferredVersion: '1.0' });
```

## Recommendation

- **Serve v1.0 as primary**, let A2X down-convert for v0.3 consumers. This is the default; you don't have to do anything.
- **Pin your own clients to v1.0** when calling agents that support both. Future-facing.
- **Only override defaults** when you need cross-version compatibility for a specific deployment target.
