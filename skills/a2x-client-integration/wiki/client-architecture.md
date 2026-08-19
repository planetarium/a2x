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
        ├─ non-2xx → throw InternalError
        └─ 200 OK  → parse JSON-RPC / SSE response
                         │
                         └─ first task/status is auth-required
                              → _authProvider.refresh(_resolvedSchemes)
                              → retry ONCE
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

### `auth-required` is the re-auth path

The SDK re-invokes the auth provider when a task-creating response reports **`auth-required`** and `authProvider.refresh` is defined. `sendMessage` checks its returned task; `sendMessageStream` buffers the first status event and checks it before yielding. Both retry exactly once. If the retry is still `auth-required`, the task or event is surfaced to the caller.

HTTP 401 is not a refresh signal in `A2XClient`. Any non-2xx response is thrown as `InternalError('HTTP <status>: <statusText>')`.

If you want to retry further on auth failures, inspect `task.status.state` yourself and construct a new client on failure.

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

- Declared `protocolVersion` starting with `0.3` → `0.3`
- Declared `protocolVersion` starting with `1.` → `1.0`
- Presence of a non-empty `supportedInterfaces` array → `1.0`
- Presence of top-level `url: string` → `0.3`
- Ambiguous → `1.0` (default)

The declared version is authoritative. A v0.3 card may also advertise `supportedInterfaces`; the client must not misclassify it from shape alone.

For **v0.3** the client mutates the outgoing `params`:

- `message.kind` is set to `"message"` if missing
- Each `Part` is rewritten to the v0.3 wire format:
  - `{ text }` → `{ kind: "text", text }`
  - `{ data }` → `{ kind: "data", data }`
  - `{ raw, url, mediaType, filename }` → `{ kind: "file", file: { bytes, uri, mimeType, name } }`
- `configuration` passes through using the spec-shaped fields (`blocking`, `historyLength`, `pushNotificationConfig`, and `acceptedOutputModes`)

For **v1.0**, params pass through unchanged.

This transformation is internal — your application always uses the v1.0-style `SendMessageParams` interface regardless of the remote agent's version.

---

## Options

```typescript
interface A2XClientOptions {
  fetch?: typeof globalThis.fetch;     // inject a custom fetch (proxy, retries, logging)
  headers?: Record<string, string>;    // applied to every request (after auth headers — auth wins on conflict? no, custom headers win)
  authProvider?: AuthProvider;         // see auth-provider.md
  extensions?: string[];               // activate A2A extension URIs on every JSON-RPC request
  x402?: A2XClientX402Options;         // optional transparent payer-side x402 flow
}
```

Register another extension later with `client.registerExtension(uri)` and inspect the current set through `client.activatedExtensions`. When `x402` is configured, the client activates the appropriate x402 extension URI automatically after resolving the card.

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
