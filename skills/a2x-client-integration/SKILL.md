---
name: a2x-client-integration
description: Integrates `@a2x/sdk` **client-side** into a TypeScript application — call remote A2A agents from a Node.js CLI, Express/Fastify backend, Next.js server action, or background worker. Covers `A2XClient`, the `AuthProvider` fallback chain, `AuthScheme` handling, token persistence, SSE streaming consumption, and error mapping. Use when the user says things like "call an A2A agent", "use A2XClient", "consume an a2x agent", "add a2x client", "authenticate against an a2x agent", "stream from an a2x agent", or wants to embed remote agent access into their own app.
---

# a2x-client-integration

Consume remote A2A agents from any TypeScript application using `@a2x/sdk` (via the `@a2x/sdk/client` subpath).

The server side is covered by the companion [`a2x-integration`](../a2x-agent-integration/SKILL.md) skill — this skill focuses exclusively on the **caller** side: fetching the agent card, authenticating dynamically against the agent's declared security schemes, sending messages, streaming SSE events, and surviving token expiry.

The `a2x` CLI (`packages/cli/src/cli-auth-provider.ts` + `packages/cli/src/token-store.ts`) is the reference implementation. This skill follows it while hardening documented integration patterns where the CLI's local compatibility format has known limits, such as duplicate auth-scheme classes in one requirement group.

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
| **Error Handling** | [wiki/error-handling.md](./wiki/error-handling.md) | JSON-RPC error codes, auth-required refresh, connection errors |

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
import {
  A2XClient,
  getAgentEndpointUrl,
  resolveAgentCard,
} from '@a2x/sdk/client';
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
3. **Refresh on `auth-required`** — when a task-creating response reports the protocol-level `auth-required` state, clear the cache and re-run the interactive step.

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

const API_KEY_ENV_BY_SLOT: Record<string, string> = {
  'header:x-api-key': 'AGENT_API_KEY',
  'header:x-tenant-key': 'AGENT_TENANT_API_KEY',
};

function apiKeySlot(scheme: ApiKeyAuthScheme): string {
  const name = scheme.params.location === 'header'
    ? scheme.params.name.toLowerCase()
    : scheme.params.name;
  return `${scheme.params.location}:${name}`;
}

export class EnvAuthProvider implements AuthProvider {
  async provide(requirements: AuthScheme[][]): Promise<AuthScheme[]> {
    // Pick the first group we can satisfy from env.
    for (const group of requirements) {
      const credentials = group.map((scheme) => this.readCredential(scheme));
      if (credentials.every(
        (value): value is string => typeof value === 'string' && value.length > 0,
      )) {
        group.forEach((scheme, index) => scheme.setCredential(credentials[index]!));
        return group;
      }
    }
    throw new Error(
      'No configured credentials match the agent security requirements',
    );
  }

  private readCredential(scheme: AuthScheme): string | undefined {
    if (scheme instanceof ApiKeyAuthScheme) {
      const envName = API_KEY_ENV_BY_SLOT[apiKeySlot(scheme)];
      return envName ? process.env[envName] : undefined;
    }
    if (scheme instanceof HttpBearerAuthScheme) {
      return process.env.AGENT_BEARER_TOKEN;
    }
    return undefined;
  }
}
```

Map every API-key location/name pair separately; one AND group may require multiple API keys. OAuth schemes expose the flow catalogue as `params.scopes`; OAuth and OIDC schemes expose selected requirement values as `params.requiredScopes`. Request only the latter after validating them against the catalogue and host policy. Treat identity endpoints and scopes advertised by an agent card as untrusted until the exact card URL, resolved agent endpoint, HTTPS identity endpoints, client identity, audience/resource, and scopes match one host policy tuple. The backend and OAuth wiki pages show both patterns.

For an interactive CLI, follow [wiki/host-cli.md](./wiki/host-cli.md) — it reproduces the full fallback chain including the OAuth2 device-code polling loop.

---

### Step 4 — Wire Up `A2XClient`

```typescript
import { A2XClient } from '@a2x/sdk/client';
import type { SendMessageParams } from '@a2x/sdk';
import crypto from 'node:crypto';

function exactHttpsUrl(raw: string | undefined, label: string): string {
  if (!raw) throw new Error(`${label} is required`);
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' || url.username || url.password ||
    url.search || url.hash
  ) throw new Error(`${label} must be an exact credential-free HTTPS URL`);
  return url.toString();
}
const AGENT_CARD_URL = exactHttpsUrl(
  process.env.AGENT_CARD_URL,
  'AGENT_CARD_URL',
);
if (!new URL(AGENT_CARD_URL).pathname.endsWith('.json')) {
  throw new Error('AGENT_CARD_URL must name one exact JSON document');
}
const EXPECTED_AGENT_ENDPOINT = exactHttpsUrl(
  process.env.AGENT_ENDPOINT_URL,
  'AGENT_ENDPOINT_URL',
);
const noRedirectFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, redirect: 'error' });
const resolved = await resolveAgentCard(AGENT_CARD_URL, {
  fetch: noRedirectFetch,
});
const endpoint = exactHttpsUrl(
  getAgentEndpointUrl(resolved.card, resolved.version),
  'AgentCard endpoint',
);
if (endpoint !== EXPECTED_AGENT_ENDPOINT) {
  throw new Error(`AgentCard endpoint is not approved: ${endpoint}`);
}

const client = new A2XClient(resolved.card, {
  headers: { 'User-Agent': 'my-app/1.0' },
  authProvider: new EnvAuthProvider(),
  extensions: ['https://example.com/my-a2a-extension/v1'],
  fetch: noRedirectFetch,
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

`AGENT_CARD_URL` and `EXPECTED_AGENT_ENDPOINT` must be exact HTTPS deployment-policy values; validate credentials/hash/query and the exact `.json` card path as shown in [the backend preflight](./wiki/host-backend.md#client-lifetime). `A2XClient` transparently handles:

- Fetching `/.well-known/agent.json` (tries `agent.json` then `agent-card.json`)
- Detecting protocol version (v0.3 vs. v1.0) from the card structure
- Normalizing security requirements into `AuthScheme[][]` and calling your provider
- Formatting the message body per protocol version
- Activating requested A2A extensions through `X-A2A-Extensions`
- Retrying a task-creating call once when its result is `auth-required` and `authProvider.refresh()` exists

An HTTP 401 is a transport failure and is surfaced as `InternalError`; it does not invoke `refresh()` automatically.

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

### Step 6 — Enable x402 Payments (Optional)

`A2XClient` can run the payer-side x402 flow transparently. Install the optional payment peers, provide a viem `LocalAccount`, and always set a per-requirement authorization ceiling:

```bash
npm install @a2x/sdk @x402/core @x402/evm viem
```

```typescript
const paidClient = new A2XClient(AGENT_URL, {
  x402: {
    signer,
    maxAmount: 10_000n,
    // This receives the complete accepts[] envelope before offer selection.
    onPaymentRequired: async (required) => confirmEnvelopeWithUser(required),
  },
});
```

`maxAmount` is expressed in the asset's atomic units and applies to each selected requirement (or each new batch deposit); it is not an aggregate wallet budget across calls. The default selector chooses an affordable EVM `exact` offer. Enable `allowUpto` only with explicit consent because it authorizes a charge up to the advertised maximum. To use `batch-settlement`, provide `batchSettlement` storage and opt in with `allowBatchSettlement`; route each payer through a durable single-owner queue/actor for the full sign → submit → reconcile lifecycle.

`onPaymentRequired` sees a detached snapshot of the full envelope before affordability filtering and offer selection. Use it for envelope-level policy; mutations are ignored. Drive the [low-level manual flow](https://github.com/planetarium/a2x/blob/main/packages/a2x/docs/guides/advanced/x402-payments.md#low-level-signx402payment) when the user must approve the exact selected offer. A custom `selectRequirement` is itself explicit scheme consent: it bypasses `allowUpto` and `allowBatchSettlement`, although `maxAmount` still filters offers and batch selection still requires `batchSettlement`. Never embed a service private key in a browser bundle; use a user-owned restricted signer or a backend payer. See the [x402 payments guide](https://github.com/planetarium/a2x/blob/main/packages/a2x/docs/guides/advanced/x402-payments.md) for reconciliation and recovery requirements.

---

### Step 7 — Verify

1. **Build check** — Run the project's type-check (`tsc --noEmit`).
2. **Agent card fetch** — manually or via the built-in resolver:
   ```typescript
   import { resolveAgentCard } from '@a2x/sdk/client';
   const resolved = await resolveAgentCard(AGENT_URL);
   console.log(resolved.version, resolved.card);
   ```
3. **Send a message** — confirm the round-trip works with your `AuthProvider`.
4. **Simulate token expiry** — make the server return an `auth-required` unary task or an `auth-required` status as the first stream event, then confirm `refresh()` is invoked and the request is retried.
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
  ├─ 1. Stored credentials?           ─ yes →  match every credential slot    → return group
  │                                             (scheme.setCredential from cache)
  │                                   ─ no  ↓
  ├─ 2. Interactive resolution
  │     • If 1 group → use it
  │     • If >1 groups → ask user to pick
  │     • For each scheme in the group → prompt / device-code / etc.
  │     • Save resolved credentials to the store
  │     ↓
  └─ return group


refresh(schemes)  ← SDK calls this after an auth-required task/event
  • Clear stored credentials for this agent URL
  • Re-run interactive resolution for the same schemes
  • Save the new values
  • Return the (same) scheme instances, now holding new credentials
```

Three properties are load-bearing:

1. **Persist a unique credential-slot key.** The reference CLI currently stores only `scheme.constructor.name`; that works only when a requirement group contains at most one instance of each subclass. A valid group can contain two API-key schemes with different names, so new integrations should key each slot by requirement-group index, scheme index, class, and public parameters.
2. **Scheme instances are mutated, not replaced.** `AuthProvider` returns the same instances the SDK handed in — only `setCredential()` has been called. The SDK will then call `applyToRequest(ctx)` on each.
3. **Credential extraction goes through `applyToRequest`.** The stored credential isn't exposed directly on the scheme; the CLI recovers it by running `applyToRequest` against a dummy context and reading the resulting `Authorization` / header / query value back out. This keeps the provider agnostic of each scheme's private state.

See [wiki/token-persistence.md](./wiki/token-persistence.md) for the `extractCredential` helper and [wiki/auth-schemes.md](./wiki/auth-schemes.md) for per-scheme handling.

---

## Key Classes and Their Contracts

| Class / Type | Where | Contract |
|-------------|-------|----------|
| `A2XClient` | `@a2x/sdk/client` | One instance per remote agent; caches the resolved card and auth schemes; optionally activates extensions and runs x402 payments |
| `AuthProvider` | `@a2x/sdk/client` | `provide(req[][])` → `AuthScheme[]`; optional `refresh(schemes)` |
| `AuthScheme` (base) | `@a2x/sdk/client` | `setCredential(string): this`; `applyToRequest(ctx): void` |
| `ApiKeyAuthScheme` | `@a2x/sdk/client` | `params: { name, location }`; header / query / cookie placement |
| `HttpBearerAuthScheme` | `@a2x/sdk/client` | `Authorization: Bearer <token>` |
| `HttpBasicAuthScheme` | `@a2x/sdk/client` | `Authorization: Basic <base64>` |
| `OAuth2DeviceCodeAuthScheme` | `@a2x/sdk/client` | `params: { deviceAuthorizationUrl, tokenUrl, scopes, refreshUrl?, requiredScopes? }` |
| `OAuth2AuthorizationCodeAuthScheme` | `@a2x/sdk/client` | `params: { authorizationUrl, tokenUrl, scopes, refreshUrl?, pkceRequired?, requiredScopes? }` |
| `OAuth2ClientCredentialsAuthScheme` | `@a2x/sdk/client` | `params: { tokenUrl, scopes, refreshUrl?, requiredScopes? }` |
| `OAuth2ImplicitAuthScheme` | `@a2x/sdk/client` | `params: { authorizationUrl, scopes, refreshUrl?, requiredScopes? }` |
| `OAuth2PasswordAuthScheme` | `@a2x/sdk/client` | `params: { tokenUrl, scopes, refreshUrl?, requiredScopes? }` |
| `OpenIdConnectAuthScheme` | `@a2x/sdk/client` | `params: { openIdConnectUrl, requiredScopes? }` |
| `resolveAgentCard` | `@a2x/sdk/client` | Standalone card fetcher; tries well-known paths |
| `normalizeRequirements` | `@a2x/sdk/client` | Low-level; expose if you want to inspect requirements without a client |

---

## What This Skill Does NOT Cover

- **Server-side integration** — how to expose an A2A agent. See [`a2x-integration`](../a2x-agent-integration/SKILL.md).
- **Agent authoring** — writing `LlmAgent`, tools, providers. See [`a2x-integration/wiki/tools-and-agents.md`](../a2x-agent-integration/wiki/tools-and-agents.md).
- **Merchant-side x402 policy** — pricing, verification, settlement, and durable merchant state. See the [x402 payments guide](https://github.com/planetarium/a2x/blob/main/packages/a2x/docs/guides/advanced/x402-payments.md).
- **CLI usage** — use the packaged `a2x` CLI and its `a2a`, `wallet`, and `x402` command help.

---

## After Applying

Remind the user to:

1. Set any environment variables the `AuthProvider` needs (API keys, bearer tokens, OAuth client IDs).
2. Audit the token storage location if they enabled persistence. The reference CLI writes a plaintext `0600` file and creates its directory as `0700` when absent, but it does not repair an existing directory's mode; production applications should prefer an OS keychain or secret manager.
3. Add a **connection error** path distinct from an **auth** path — the SDK throws `InternalError` for HTTP-level failures and typed `A2AError` subclasses (e.g. `TaskNotFoundError`) for protocol-level failures, while protocol-level task authentication failures surface as `auth-required` state (not a thrown error). See [wiki/error-handling.md](./wiki/error-handling.md).
4. Consider retry / backoff for `getTask`. Reconcile `cancelTask` after an ambiguous transport failure because the first cancellation may already have succeeded; never automatically retry `sendMessage` without an application-level idempotency strategy.
