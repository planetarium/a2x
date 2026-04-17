---
name: a2x-client-integration
description: Integrates `@a2x/sdk` **client-side** into a TypeScript application — call remote A2A agents from a Node.js CLI, Express/Fastify backend, Next.js server action, or background worker. Covers `A2XClient`, the `AuthProvider` fallback chain, `AuthScheme` handling, token persistence, SSE streaming consumption, and error mapping. Use when the user says things like "call an A2A agent", "use A2XClient", "consume an a2x agent", "add a2x client", "authenticate against an a2x agent", "stream from an a2x agent", or wants to embed remote agent access into their own app.
---

# a2x-client-integration

Consume remote A2A agents from any TypeScript application using `@a2x/sdk` (via the `@a2x/sdk/client` subpath).

The server side is covered by the companion [`a2x-integration`](../a2x-integration/SKILL.md) skill — this skill focuses exclusively on the **caller** side: fetching the agent card, authenticating dynamically against the agent's declared security schemes, sending messages, streaming SSE events, and surviving token expiry.

The reference implementation for all of this is the `a2x` CLI itself (`packages/cli/src/cli-auth-provider.ts` + `packages/cli/src/token-store.ts`). The patterns documented here are lifted directly from that implementation.

---

## Before You Start

**IMPORTANT**: `@a2x/sdk` evolves quickly. Before writing code:

1. Install the latest `@a2x/sdk` (never hardcode versions).
2. Read actual type definitions from `node_modules/@a2x/sdk/dist/client/index.d.ts` to confirm the current API surface.
3. If a class or export referenced in this skill is missing, search `node_modules/@a2x/sdk` for the closest equivalent — the normalization logic and `AuthProvider` contract have been stable, but scheme class names may shift.

---

## Wiki Reference

This skill uses a wiki-style structure. Detailed reference material is in the `wiki/` directory:

| Topic | File | Description |
|-------|------|-------------|
| **Client Architecture** | [wiki/client-architecture.md](./wiki/client-architecture.md) | How `A2XClient` resolves, authenticates, sends, streams |
| **Agent Card Resolution** | [wiki/agent-card-resolution.md](./wiki/agent-card-resolution.md) | Well-known paths, protocol version detection, endpoint URL |
| **Auth Provider Contract** | [wiki/auth-provider.md](./wiki/auth-provider.md) | `AuthProvider` interface, OR-of-ANDs normalization, lifecycle |
| **Auth Schemes** | [wiki/auth-schemes.md](./wiki/auth-schemes.md) | Every built-in `AuthScheme` class — how to feed each one |
| **Fallback Chain** | [wiki/auth-fallback-chain.md](./wiki/auth-fallback-chain.md) | **Stored → Interactive → Refresh** chain from the CLI reference |
| **Token Persistence** | [wiki/token-persistence.md](./wiki/token-persistence.md) | File-based store pattern, credential extraction, security notes |
| **OAuth2 Device Code** | [wiki/oauth2-device-code.md](./wiki/oauth2-device-code.md) | Full device-code polling loop for headless clients |
| **Streaming** | [wiki/streaming.md](./wiki/streaming.md) | `sendMessageStream`, SSE parsing, cancellation, terminal states |
| **Error Handling** | [wiki/error-handling.md](./wiki/error-handling.md) | JSON-RPC error codes, 401 refresh, connection errors |

### Host-Environment Guides

| Environment | File |
|-------------|------|
| **Node.js CLI (interactive)** | [wiki/host-cli.md](./wiki/host-cli.md) |
| **Backend service (non-interactive)** | [wiki/host-backend.md](./wiki/host-backend.md) |
| **Next.js server action / route handler** | [wiki/host-nextjs.md](./wiki/host-nextjs.md) |
| **Browser (SPA)** | [wiki/host-browser.md](./wiki/host-browser.md) |

---

## Workflow

### Step 0 — Analyze the Host Project

Before any implementation:

1. Read `package.json` to identify the package manager, runtime (Node vs. browser), and existing HTTP/UI framework.
2. Determine the **host environment** — this drives how you implement `AuthProvider.provide()`:
   - **Interactive CLI** — prompt user on stdin (device-code flow, prompts for keys). See [wiki/host-cli.md](./wiki/host-cli.md).
   - **Backend service / cron / worker** — credentials come from env vars or a secret manager. No prompting. See [wiki/host-backend.md](./wiki/host-backend.md).
   - **Next.js server action / route handler** — credentials come from the session / request headers. No prompting. See [wiki/host-nextjs.md](./wiki/host-nextjs.md).
   - **Browser** — credentials come from a login flow (redirect-based OAuth or an upstream proxy). See [wiki/host-browser.md](./wiki/host-browser.md).
3. Identify which remote agent(s) the user is calling and which **security schemes** those agents advertise (`GET /.well-known/agent.json` → `securitySchemes` / `security` / `securityRequirements`). The right `AuthProvider` implementation is driven by this.

---

### Step 1 — Install the Package

```bash
# Use the project's package manager
npm install @a2x/sdk
```

Only the **client** subpath and the root types are needed on the caller side:

```typescript
import { A2XClient } from '@a2x/sdk/client';
import type { SendMessageParams, Task, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from '@a2x/sdk';
```

You do **not** need to install any LLM provider SDK (`@google/genai`, `@anthropic-ai/sdk`, `openai`) — those are only required for agent servers.

After installation, verify the expected exports exist:

```bash
grep -rE "^export" node_modules/@a2x/sdk/dist/client/index.d.ts 2>/dev/null
```

Look for:

| Export | Purpose |
|--------|---------|
| `A2XClient` | Client class |
| `AuthProvider` (type) | Interface you implement |
| `AuthScheme`, `ApiKeyAuthScheme`, `HttpBearerAuthScheme`, … | Scheme classes the SDK hands to your provider |
| `resolveAgentCard` | Standalone card fetcher |
| `normalizeRequirements`, `normalizeScheme` | Exposed for advanced cases |

---

### Step 2 — Pick an AuthProvider Strategy

`AuthProvider` is the integration point between the SDK and the host application. The SDK never decides **how** credentials are obtained — it only calls your provider with the normalized OR-of-ANDs requirement list and expects a resolved group back.

Map your host environment to a pattern:

| Environment | `provide()` behavior | `refresh()` behavior |
|-------------|----------------------|----------------------|
| Interactive CLI | Prompt the user; persist result to `~/.a2x/tokens.json` | Clear stored token, re-prompt |
| Backend service | Read from env / secret manager | Throw (let the call fail) or re-read |
| Next.js route | Read from session cookie / headers | Trigger re-auth redirect upstream |
| Browser | Read from in-memory auth store; `window.location` redirect for OAuth | Trigger re-auth redirect |

The [CLI reference implementation](./wiki/auth-fallback-chain.md) composes the three steps into one chain:

1. **Stored credentials first** — try cached values; if they match a requirement group, use them.
2. **Interactive fallback** — if none match, prompt the user for a group they can satisfy.
3. **Refresh on 401** — on auth failure, clear the cache and re-run the interactive step.

Pick the subset that makes sense for your host. Backend services typically skip step 2 entirely.

---

### Step 3 — Implement the Provider

Create a file appropriate to the host (e.g. `src/lib/a2a-auth.ts` for a backend, `src/cli/auth-provider.ts` for a CLI).

Minimal non-interactive (backend) shape — read credentials from env:

```typescript
import type { AuthProvider } from '@a2x/sdk/client';
import {
  AuthScheme,
  ApiKeyAuthScheme,
  HttpBearerAuthScheme,
} from '@a2x/sdk/client';

export class EnvAuthProvider implements AuthProvider {
  async provide(requirements: AuthScheme[][]): Promise<AuthScheme[]> {
    // Pick the first group we can satisfy from env.
    for (const group of requirements) {
      const ok = group.every((scheme) => this.tryFill(scheme));
      if (ok) return group;
    }
    throw new Error(
      'No configured credentials match the agent security requirements',
    );
  }

  private tryFill(scheme: AuthScheme): boolean {
    if (scheme instanceof ApiKeyAuthScheme) {
      const key = process.env.AGENT_API_KEY;
      if (!key) return false;
      scheme.setCredential(key);
      return true;
    }
    if (scheme instanceof HttpBearerAuthScheme) {
      const token = process.env.AGENT_BEARER_TOKEN;
      if (!token) return false;
      scheme.setCredential(token);
      return true;
    }
    return false;
  }
}
```

For an interactive CLI, follow [wiki/host-cli.md](./wiki/host-cli.md) — it reproduces the full fallback chain including the OAuth2 device-code polling loop.

---

### Step 4 — Wire Up `A2XClient`

```typescript
import { A2XClient } from '@a2x/sdk/client';
import type { SendMessageParams } from '@a2x/sdk';
import crypto from 'node:crypto';

const client = new A2XClient(AGENT_URL, {
  headers: { 'User-Agent': 'my-app/1.0' },
  authProvider: new EnvAuthProvider(),
  // fetch: customFetch,  // optional: inject a fetch (e.g. with proxy / retries)
});

const params: SendMessageParams = {
  message: {
    messageId: crypto.randomUUID(),
    role: 'user',
    parts: [{ text: 'Hello' }],
  },
};

const task = await client.sendMessage(params);
console.log(task.status?.state, task.artifacts);
```

`A2XClient` transparently handles:

- Fetching `/.well-known/agent.json` (tries `agent.json` then `agent-card.json`)
- Detecting protocol version (v0.3 vs. v1.0) from the card structure
- Normalizing security requirements into `AuthScheme[][]` and calling your provider
- Formatting the message body per protocol version
- Retrying once on HTTP 401 via `authProvider.refresh()`

---

### Step 5 — Stream (Optional)

```typescript
const stream = client.sendMessageStream(params);

for await (const event of stream) {
  if ('status' in event) {
    console.log('status →', event.status.state);
  } else {
    // artifact-update event
    for (const part of event.artifact.parts) {
      if ('text' in part) process.stdout.write(part.text);
    }
  }
}
```

Cancellation via `AbortSignal`:

```typescript
const ac = new AbortController();
setTimeout(() => ac.abort(), 30_000);

for await (const event of client.sendMessageStream(params, ac.signal)) { /* … */ }
```

See [wiki/streaming.md](./wiki/streaming.md) for SSE format details, terminal-state detection, and error handling during a stream.

---

### Step 6 — Verify

1. **Build check** — Run the project's type-check (`tsc --noEmit`).
2. **Agent card fetch** — manually or via the built-in resolver:
   ```typescript
   import { resolveAgentCard } from '@a2x/sdk/client';
   const resolved = await resolveAgentCard(AGENT_URL);
   console.log(resolved.version, resolved.card);
   ```
3. **Send a message** — confirm the round-trip works with your `AuthProvider`.
4. **Simulate token expiry** — make the server reject with HTTP 401 once, confirm `refresh()` is invoked.
5. **Try with the `a2x` CLI** for a sanity check against the same agent:
   ```bash
   a2x a2a agent-card <AGENT_URL>
   a2x a2a send <AGENT_URL> "ping"
   ```

---

## The Authentication Fallback Chain (Reference)

The CLI in this repo implements a three-step fallback that every interactive client should follow. Full walkthrough in [wiki/auth-fallback-chain.md](./wiki/auth-fallback-chain.md); summary:

```
provide(requirements)
  │
  ├─ 1. Stored credentials?           ─ yes →  match group by className       → return group
  │                                             (scheme.setCredential from cache)
  │                                   ─ no  ↓
  ├─ 2. Interactive resolution
  │     • If 1 group → use it
  │     • If >1 groups → ask user to pick
  │     • For each scheme in the group → prompt / device-code / etc.
  │     • Save resolved credentials to the store
  │     ↓
  └─ return group


refresh(schemes)  ← SDK calls this after HTTP 401
  • Clear stored credentials for this agent URL
  • Re-run interactive resolution for the same schemes
  • Save the new values
  • Return the (same) scheme instances, now holding new credentials
```

Three properties are load-bearing:

1. **Scheme class name is the stable identity.** The CLI stores `scheme.constructor.name` alongside the raw credential and matches on that when restoring. The SDK always instantiates the same classes from a given agent card, so the name is a safe key.
2. **Scheme instances are mutated, not replaced.** `AuthProvider` returns the same instances the SDK handed in — only `setCredential()` has been called. The SDK will then call `applyToRequest(ctx)` on each.
3. **Credential extraction goes through `applyToRequest`.** The stored credential isn't exposed directly on the scheme; the CLI recovers it by running `applyToRequest` against a dummy context and reading the resulting `Authorization` / header / query value back out. This keeps the provider agnostic of each scheme's private state.

See [wiki/token-persistence.md](./wiki/token-persistence.md) for the `extractCredential` helper and [wiki/auth-schemes.md](./wiki/auth-schemes.md) for per-scheme handling.

---

## Key Classes and Their Contracts

| Class / Type | Where | Contract |
|-------------|-------|----------|
| `A2XClient` | `@a2x/sdk/client` | One instance per remote agent; caches resolved card + auth schemes |
| `AuthProvider` | `@a2x/sdk/client` | `provide(req[][])` → `AuthScheme[]`; optional `refresh(schemes)` |
| `AuthScheme` (base) | `@a2x/sdk/client` | `setCredential(string): this`; `applyToRequest(ctx): void` |
| `ApiKeyAuthScheme` | `@a2x/sdk/client` | `params: { name, location }`; header / query / cookie placement |
| `HttpBearerAuthScheme` | `@a2x/sdk/client` | `Authorization: Bearer <token>` |
| `HttpBasicAuthScheme` | `@a2x/sdk/client` | `Authorization: Basic <base64>` |
| `OAuth2DeviceCodeAuthScheme` | `@a2x/sdk/client` | `params: { deviceAuthorizationUrl, tokenUrl, scopes, refreshUrl? }` |
| `OAuth2AuthorizationCodeAuthScheme` | `@a2x/sdk/client` | `params: { authorizationUrl, tokenUrl, scopes, refreshUrl?, pkceRequired? }` |
| `OAuth2ClientCredentialsAuthScheme` | `@a2x/sdk/client` | `params: { tokenUrl, scopes, refreshUrl? }` |
| `OAuth2ImplicitAuthScheme` | `@a2x/sdk/client` | `params: { authorizationUrl, scopes, refreshUrl? }` |
| `OAuth2PasswordAuthScheme` | `@a2x/sdk/client` | `params: { tokenUrl, scopes, refreshUrl? }` |
| `OpenIdConnectAuthScheme` | `@a2x/sdk/client` | `params: { openIdConnectUrl }` |
| `resolveAgentCard` | `@a2x/sdk/client` | Standalone card fetcher; tries well-known paths |
| `normalizeRequirements` | `@a2x/sdk/client` | Low-level; expose if you want to inspect requirements without a client |

---

## What This Skill Does NOT Cover

- **Server-side integration** — how to expose an A2A agent. See [`a2x-integration`](../a2x-integration/SKILL.md).
- **Agent authoring** — writing `LlmAgent`, tools, providers. See `a2x-integration/wiki/tools-and-agents.md`.
- **x402 payments** — paywalling agent calls. See `a2a-x402-integration` skill.
- **CLI usage** — using the packaged `a2x` CLI as a tool. See the `a2a-wallet` skill and the CLI's own docs.

---

## After Applying

Remind the user to:

1. Set any environment variables the `AuthProvider` needs (API keys, bearer tokens, OAuth client IDs).
2. Audit the token storage location if they enabled persistence — a world-readable file with bearer tokens is a security hazard.
3. Add a **connection error** path distinct from **auth error** path — the SDK throws `InternalError` for HTTP-level failures and typed `A2AError` subclasses (e.g. `AuthenticationRequiredError`) for protocol-level failures. See [wiki/error-handling.md](./wiki/error-handling.md).
4. Consider retry / backoff for idempotent operations (`getTask`, `cancelTask`) — the SDK itself does no retrying beyond the single 401 refresh.
