# Client Architecture

How `A2XClient` orchestrates agent-card resolution, authentication, and transport.

---

## High-Level Flow

```
new A2XClient(urlOrCard, { headers, authProvider, fetch })
        │
        │   first call (e.g. sendMessage, sendMessageStream, getTask)
        ▼
  _ensureResolved()                 ← runs once, memoizes
        │
        ├─ string URL  → resolveAgentCard() → tries well-known paths
        └─ AgentCard   → detect version, derive endpoint URL
        ▼
  _ensureAuthenticated()            ← runs once per client lifetime
        │
        ├─ no authProvider          → skip
        ├─ card has no requirements → skip
        └─ normalizeRequirements(card) → AuthProvider.provide(req[][])
                                         ↓
                                    cached as _resolvedSchemes
        ▼
  build JSON-RPC request
        │
  _applyAuth({ headers, url })      ← every request re-applies cached schemes
        │
  fetch(endpointUrl, …)
        │
        ├─ 200 OK  → parse JSON-RPC / SSE response
        └─ 401     → _authProvider.refresh(_resolvedSchemes) → retry ONCE
```

---

## Key Invariants

### Lazy initialization

`A2XClient` does **nothing** in the constructor. Agent-card resolution and authentication both happen on the first public method call. This matters when you construct the client at module load time — there is no network I/O until you call a method.

### Resolution is memoized

`_ensureResolved()` stores the resolved card, protocol version, endpoint URL, and response parser on the instance. Re-resolution does not happen.

Consequence: if the remote agent changes its card (e.g. rotates security schemes), **a long-lived client will not pick it up**. Recreate the client on such changes.

### Authentication is memoized too

`_ensureAuthenticated()` runs once. The `AuthScheme[]` returned by `AuthProvider.provide()` is cached as `_resolvedSchemes` and re-applied to every subsequent request.

Consequence: if the `AuthProvider` has side effects (prompting the user, opening a browser), those happen **once per client** — not per request.

### Refresh is the only re-auth path

The SDK only re-invokes the auth provider under one condition: a non-streaming request returned **HTTP 401** and `authProvider.refresh` is defined. Even then it retries exactly once. Protocol-level `AuthenticationRequiredError` (JSON-RPC error code `-32004`) does **not** trigger a refresh — it surfaces as a thrown error.

If you want to retry on protocol-level auth errors too, wrap the calls yourself and construct a new client on failure.

---

## Request Shape

For `sendMessage` / `getTask` / `cancelTask`:

```json
POST <endpointUrl>
Content-Type: application/json
<auth headers from AuthScheme.applyToRequest>

{
  "jsonrpc": "2.0",
  "id": <monotonic int per client>,
  "method": "message/send" | "tasks/get" | "tasks/cancel",
  "params": <formatted per protocol version>
}
```

For `sendMessageStream`:

```
POST <endpointUrl>
Accept: text/event-stream
Content-Type: application/json
<auth headers from AuthScheme.applyToRequest>

{ "jsonrpc": "2.0", "id": …, "method": "message/stream", "params": … }
```

The server responds with either:
- `Content-Type: text/event-stream` — parsed by `parseSSEStream`, yielded as `TaskStatusUpdateEvent` | `TaskArtifactUpdateEvent`
- `Content-Type: application/json` — a JSON-RPC error; the client throws the mapped `A2AError` subclass

---

## Protocol Version Handling

Detection happens in `detectProtocolVersion`:

- Presence of `supportedInterfaces: []` → `1.0`
- Presence of top-level `url: string` → `0.3`
- Ambiguous → `1.0` (default)

For **v0.3** the client mutates the outgoing `params`:

- `message.kind` is set to `"message"` if missing
- Each `Part` is rewritten to the v0.3 wire format:
  - `{ text }` → `{ kind: "text", text }`
  - `{ data }` → `{ kind: "data", data }`
  - `{ raw, url, mediaType, filename }` → `{ kind: "file", file: { bytes, uri, mimeType, name } }`
- `configuration.returnImmediately` is inverted to `configuration.blocking`

For **v1.0**, params pass through unchanged.

This transformation is internal — your application always uses the v1.0-style `SendMessageParams` interface regardless of the remote agent's version.

---

## Options

```typescript
interface A2XClientOptions {
  fetch?: typeof globalThis.fetch;     // inject a custom fetch (proxy, retries, logging)
  headers?: Record<string, string>;    // applied to every request (after auth headers — auth wins on conflict? no, custom headers win)
  authProvider?: AuthProvider;         // see auth-provider.md
}
```

**Header precedence** (lowest → highest):

```
{ 'Content-Type': 'application/json', ...extra, ...this._headers }
```

`this._headers` (from `options.headers`) wins over `Content-Type` and `Accept`. Be careful not to override `Content-Type` or `Accept` unintentionally.

`AuthScheme.applyToRequest()` runs **after** headers are built, so auth schemes overwrite any user-provided `Authorization` header.

---

## When to Instantiate a New Client

Create a new `A2XClient`:

- Per logical "connection" to a remote agent — one instance per agent URL is the usual pattern.
- On credential change — e.g. user logs out and a new user logs in.
- On card-schema change — if you suspect the remote changed security requirements.

Do **not** create a new client per request — you lose the card-resolution and auth caches, and every request will re-fetch the agent card.
