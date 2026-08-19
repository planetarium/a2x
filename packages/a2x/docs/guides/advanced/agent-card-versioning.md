# AgentCard v0.3 vs v1.0

A2A has two spec versions in active use. The **AgentCard** — the JSON your agent serves at `/.well-known/agent.json` — differs in shape between them. Each `A2XServer` instance is bound to one wire format, chosen at construction time via `protocolVersion` (default `'1.0'`).

You usually don't pick. `toA2x()` and `DefaultRequestHandler.getAgentCard()` render whatever `protocolVersion` was configured. The card shape, the JSON-RPC response shape, and the `pushNotificationConfig` param shape always match — so clients reading the card get a faithful contract for the wire underneath.

## The key differences

| Concept | v0.3 | v1.0 |
|---|---|---|
| Where the endpoint URL lives | top-level `url` | `supportedInterfaces[].url` |
| Transport selection | `preferredTransport` string | `supportedInterfaces[].protocolBinding` |
| Security declarations | `security` array + `securitySchemes` map | `securityRequirements` array + `securitySchemes` map |
| Multiple transports on one agent | not supported | supported via multiple `supportedInterfaces` |

A2X models everything internally in a version-neutral shape and renders it through the configured wire format. This means:

- Every declaration you make on `A2XServer` (skills, security, default URL) works for both versions.
- The card and the wire are always consistent — the SDK never publishes a card whose `protocolVersion` disagrees with what the server actually emits.
- You don't write version branches in your own code.

## Picking the wire format

Pass `protocolVersion` to the constructor. The choice is fixed for the life of the agent:

```ts
const a2xServerV10 = new A2XServer({ taskStore, executor }); // v1.0 (default)
const a2xServerV03 = new A2XServer({ taskStore, executor, protocolVersion: '0.3' });

a2xServerV10.getAgentCard(); // → v1.0 card
a2xServerV03.getAgentCard(); // → v0.3 card
```

To serve both versions from one deployment, run two `A2XServer` instances behind separate URLs and advertise each in the other's `additionalInterfaces`. One instance cannot lie about its wire format.

## The v1.0 JSON-RPC binding

A2A v1.0 renamed every JSON-RPC method (spec §9.4) and both request headers. A `protocolVersion: '1.0'` server accepts the v1.0 vocabulary natively:

| v0.3 method | v1.0 method |
|---|---|
| `message/send` | `SendMessage` |
| `message/stream` | `SendStreamingMessage` |
| `tasks/get` | `GetTask` |
| `tasks/cancel` | `CancelTask` |
| `tasks/resubscribe` | `SubscribeToTask` |
| `tasks/pushNotificationConfig/set` | `CreateTaskPushNotificationConfig` |
| `tasks/pushNotificationConfig/get` | `GetTaskPushNotificationConfig` |
| `tasks/pushNotificationConfig/list` | `ListTaskPushNotificationConfigs` |
| `tasks/pushNotificationConfig/delete` | `DeleteTaskPushNotificationConfig` |
| `agent/getAuthenticatedExtendedCard` | `GetExtendedAgentCard` |

Both tables are exported as `A2A_METHODS` and `A2A_METHODS_V10`. v1.0's new `ListTasks` method has no v0.3 counterpart and is not implemented.

Three behaviors to know, and where they diverge from strict spec text:

- **Legacy method names as an SDK extension.** A v1.0 server also keeps accepting the v0.3 spellings, so existing v0.3-speaking clients (including `A2XClient`) continue to work against it. This aliasing is an A2X extension — the v1.0 spec's dual-version mechanism is `A2A-Version` negotiation, not method aliases. A `protocolVersion: '0.3'` server stays strictly v0.3 and rejects v1.0 spellings with `-32601`.
- **Extension activation header.** v1.0 renamed `X-A2A-Extensions` to `A2A-Extensions` (spec §3.2.6). Servers of either version accept both spellings; the required-extension rejection message names the header matching the server's version.
- **`A2A-Version` header.** A client may pin the protocol version per request (spec §3.2.6/§9.2). The pin is matched on `Major.Minor` per spec — `0.3.0` pins the same version as `0.3`. When the pinned version doesn't match the server's `protocolVersion`, the server returns `VersionNotSupportedError` (`-32009`). When the header is absent, the server serves its configured version — the spec's "assume 0.3 when the header is empty" rule presumes per-request encoding selection, which a single-version `A2XServer` deliberately does not do.

## When this matters to you

Three scenarios where you actually need to care:

### 1. Deploying alongside legacy v0.3 clients

If you have CLI tools or third-party agents still pinned to v0.3, they read `url` and `preferredTransport` — not `supportedInterfaces`. Construct the agent with `protocolVersion: '0.3'` and the SDK will speak v0.3 end-to-end (card + wire). For deployments that need to serve both at once, see [Multi-transport agents](#3-multi-transport-agents) below.

### 2. Emitting a non-standard scheme on v0.3

OAuth 2.0 Device Code is a v1.0-native security flow. A2X extends it onto v0.3 cards as a non-standard extension so headless clients can still negotiate it. See [Protocol Extensions](./extensions.md) for details.

### Advertising the authenticated extended card

When you call `a2xServer.setAuthenticatedExtendedCardProvider(...)`, A2X flips the version-specific capability flag on the base card automatically:

- v0.3: top-level `supportsAuthenticatedExtendedCard: true`
- v1.0: `capabilities.extendedAgentCard: true`

Conforming clients read this to decide whether to call `agent/getAuthenticatedExtendedCard`. You don't set either flag by hand — registering the provider is the only signal you need. See [Authenticated Extended AgentCard](./extended-agent-card.md).

### 3. Multi-transport agents

If you plan to expose JSON-RPC over HTTP **and** another transport (e.g. gRPC), only v1.0 expresses this cleanly. Legacy v0.3 consumers will only see the first/primary interface.

## Consuming: what `A2XClient` does

On the client side, `A2XClient` reads the remote card's `protocolVersion` field (or infers v0.3 when absent) and routes calls accordingly. You usually don't need to pick a version yourself:

```ts
import { resolveAgentCard } from '@a2x/sdk/client';

const resolved = await resolveAgentCard(agentCardUrl);
console.log(resolved.version);   // '0.3' | '1.0'
console.log(resolved.card);      // the parsed card for that version
```

`A2XClient` has no `preferredVersion` option. The resolved card is authoritative; use a deployment-specific card URL when a peer publishes separate cards for different protocol versions.

## Recommendation

- **Serve v1.0 as primary** — the constructor default. New clients should target v1.0.
- **Pin your own clients to v1.0** when calling agents that support both. Future-facing.
- **Spin up a dedicated v0.3 instance** only when a deployment target needs it. Configure it with `protocolVersion: '0.3'` rather than trying to coax a v1.0 agent into pretending.

## Beyond the AgentCard: push notification authentication

`tasks/pushNotificationConfig/{set,get,list}` carries an optional `authentication` block whose shape diverges between specs:

| Version | Shape | Notes |
|---|---|---|
| v0.3 | `{ schemes: string[], credentials? }` | `schemes` required and non-empty |
| v1.0 | `{ scheme: string, credentials? }` | `scheme` required; `additionalProperties: false` |

A2X stores the v0.3 shape internally and translates at the v1.0 boundary: `scheme = schemes[0]` outbound, `schemes = [scheme]` inbound. The conversion is lossy when v0.3 lists more than one scheme — only the first is preserved on a v1.0 wire. Configure your agent's `protocolVersion` to match the wire your clients speak; the SDK handles the rest.

The wrapping `TaskPushNotificationConfig` itself also differs between specs:

| Version | Shape | Notes |
|---|---|---|
| v0.3 | `{ taskId, pushNotificationConfig: { id?, url, token?, authentication? } }` | Nested |
| v1.0 | `{ taskId, id?, url, token?, authentication?, tenant? }` | Flat (proto `TaskPushNotificationConfig`) |

A v1.0-configured `tasks/pushNotificationConfig/set` accepts the flat input shape so a client can round-trip the response it just received. The internal storage is always the nested form; the response mapper flattens for v1.0 wires.
