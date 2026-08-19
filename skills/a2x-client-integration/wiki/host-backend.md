# Host: Backend Service (Non-Interactive)

For long-running servers, cron jobs, background workers, and CI pipelines. No stdin, no user prompting. Credentials come from environment variables or a secret manager, and `provide()` fails loudly if they're missing.

---

## Key Differences from the CLI

| Concern | CLI | Backend |
|---------|-----|---------|
| `provide()` | Prompts user | Reads from env/secret manager, throws if absent |
| Persistence | File at `~/.a2x/tokens.json` | Usually in-memory only; occasionally a KV/DB cache |
| `refresh()` | Clear + re-prompt | Re-read env; for OAuth2, exchange `refresh_token` |
| Client lifetime | Per process invocation | Long-lived, shared across requests |
| Concurrency | Serial | Concurrent — beware shared `_resolvedSchemes` state |

---

## Minimal Env-Based AuthProvider

```typescript
import type { AuthProvider } from '@a2x/sdk/client';
import {
  AuthScheme,
  ApiKeyAuthScheme,
  HttpBearerAuthScheme,
  HttpBasicAuthScheme,
  OAuth2ClientCredentialsAuthScheme,
} from '@a2x/sdk/client';

const API_KEY_ENV_BY_SLOT: Record<string, string> = {
  'header:x-api-key': 'AGENT_API_KEY',
  'header:x-tenant-key': 'AGENT_TENANT_API_KEY',
};

function normalizeOAuthEndpoint(raw: string): string {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash
  ) {
    throw new Error(`Invalid OAuth endpoint: ${url.origin}`);
  }
  return url.toString();
}

const TRUSTED_OAUTH_TOKEN_ENDPOINTS = new Set(
  (process.env.OAUTH_TOKEN_ENDPOINTS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(normalizeOAuthEndpoint),
);

function trustedOAuthEndpoint(raw: string, purpose: string): URL {
  const normalized = normalizeOAuthEndpoint(raw);
  if (!TRUSTED_OAUTH_TOKEN_ENDPOINTS.has(normalized)) {
    throw new Error(`Refusing untrusted OAuth ${purpose}: ${normalized}`);
  }
  return new URL(normalized);
}

const ALLOWED_OAUTH_SCOPES = new Set(
  (process.env.OAUTH_ALLOWED_SCOPES ?? '').split(/\s+/).filter(Boolean),
);

function approvedScope(
  advertised: Record<string, string>,
  required: readonly string[] | undefined,
): string {
  if (!required) {
    throw new Error('OAuth requirement omitted requiredScopes');
  }
  const requested = [...new Set(required)];
  const rejected = requested.filter(scope =>
    !(scope in advertised) || !ALLOWED_OAUTH_SCOPES.has(scope)
  );
  if (rejected.length) {
    throw new Error(`Refusing unapproved OAuth scopes: ${rejected.join(', ')}`);
  }
  return requested.join(' ');
}

function assertGrantedScope(granted?: string): void {
  if (!granted) return;
  const rejected = granted
    .split(/\s+/)
    .filter(Boolean)
    .filter(scope => !ALLOWED_OAUTH_SCOPES.has(scope));
  if (rejected.length) {
    throw new Error(`Token granted unapproved scopes: ${rejected.join(', ')}`);
  }
}

// Implement with trusted JWT verification or token introspection. Never use
// decode-only JWT claims for this check.
declare function assertTokenAudience(
  token: string,
  expectedAudience: string,
): Promise<void>;

function apiKeySlot(scheme: ApiKeyAuthScheme): string {
  const name = scheme.params.location === 'header'
    ? scheme.params.name.toLowerCase()
    : scheme.params.name;
  return `${scheme.params.location}:${name}`;
}

export class EnvAuthProvider implements AuthProvider {
  async provide(requirements: AuthScheme[][]): Promise<AuthScheme[]> {
    for (const group of requirements) {
      if (await fillGroup(group)) return group;
    }
    throw new Error(
      'No configured credentials match the agent security requirements. ' +
      'Configure the required API-key slots, AGENT_BEARER_TOKEN, or OAUTH_CLIENT_* env vars.',
    );
  }

  async refresh(schemes: AuthScheme[]): Promise<AuthScheme[]> {
    // Re-read every source so rotations are visible, and fail as a group.
    if (!(await fillGroup(schemes))) {
      throw new Error('Refreshed credentials are incomplete');
    }
    return schemes;
  }
}

async function fillGroup(group: AuthScheme[]): Promise<boolean> {
  const credentials: string[] = [];
  for (const scheme of group) {
    const credential = await resolveCredential(scheme);
    if (!credential) return false;
    credentials.push(credential);
  }
  group.forEach((scheme, index) => scheme.setCredential(credentials[index]!));
  return true;
}

async function resolveCredential(
  scheme: AuthScheme,
): Promise<string | undefined> {
  if (scheme instanceof ApiKeyAuthScheme) {
    const envName = API_KEY_ENV_BY_SLOT[apiKeySlot(scheme)];
    return envName ? process.env[envName] : undefined;
  }
  if (scheme instanceof HttpBearerAuthScheme) {
    return process.env.AGENT_BEARER_TOKEN;
  }
  if (scheme instanceof HttpBasicAuthScheme) {
    const user = process.env.AGENT_BASIC_USER;
    const pass = process.env.AGENT_BASIC_PASS;
    return user && pass
      ? Buffer.from(`${user}:${pass}`).toString('base64')
      : undefined;
  }
  if (scheme instanceof OAuth2ClientCredentialsAuthScheme) {
    return exchangeClientCredentials(scheme);
  }
  return undefined;
}

async function exchangeClientCredentials(
  scheme: OAuth2ClientCredentialsAuthScheme,
): Promise<string | undefined> {
  const clientId = process.env.OAUTH_CLIENT_ID;
  const clientSecret = process.env.OAUTH_CLIENT_SECRET;
  const expectedAudience = process.env.OAUTH_EXPECTED_AUDIENCE;
  if (!clientId || !clientSecret || !expectedAudience) return undefined;

  // Agent-card discovery is not a trust decision. Validate before sending secrets.
  const tokenUrl = trustedOAuthEndpoint(scheme.params.tokenUrl, 'token endpoint');
  const scope = approvedScope(
    scheme.params.scopes,
    scheme.params.requiredScopes,
  );
  const res = await fetch(tokenUrl, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      ...(scope ? { scope } : {}),
    }),
  });
  if (!res.ok) return undefined;
  const data = (await res.json()) as { access_token?: string; scope?: string };
  assertGrantedScope(data.scope);
  if (!data.access_token) return undefined;
  await assertTokenAudience(data.access_token, expectedAudience);
  return data.access_token;
}
```

Configure exact `OAUTH_TOKEN_ENDPOINTS` and `OAUTH_ALLOWED_SCOPES` from deployment policy; do not derive either from the agent card. `params.scopes` is only the advertised catalogue, while `params.requiredScopes` is the selected requirement: request only the latter and reject a required value absent from either the catalogue or host allowlist. In multi-agent or multi-tenant hosts, bind one provider and token cache to the exact `(card URL, resolved agent endpoint, issuer/token endpoint, client identity, expected audience/resource, required scopes)` tuple. Verify the token audience/resource (cryptographically or through trusted introspection) before attaching it. Add an explicit development-only exception if local HTTP identity infrastructure is unavoidable. Redirects are rejected because an otherwise trusted endpoint could redirect the client secret elsewhere.

API-key slots are keyed by placement and name because a valid AND group can require several distinct API keys. Add every expected slot to `API_KEY_ENV_BY_SLOT`; do not reuse one environment variable for the whole class.

---

## Client Lifetime

A long-lived backend should create the client **once** at startup, after binding discovery to the exact endpoint in host policy, and reuse it:

```typescript
// src/agents/my-agent-client.ts
import {
  A2XClient,
  getAgentEndpointUrl,
  resolveAgentCard,
} from '@a2x/sdk/client';
import { EnvAuthProvider } from './env-auth-provider.js';

function exactHttpsUrl(raw: string | undefined, label: string): string {
  if (!raw) throw new Error(`${label} is required`);
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be an exact credential-free HTTPS URL`);
  }
  return url.toString();
}

const AGENT_CARD_URL = exactHttpsUrl(
  process.env.AGENT_CARD_URL,
  'AGENT_CARD_URL',
);
if (!new URL(AGENT_CARD_URL).pathname.endsWith('.json')) {
  throw new Error('AGENT_CARD_URL must name one exact JSON card document');
}
const EXPECTED_AGENT_ENDPOINT = exactHttpsUrl(
  process.env.AGENT_ENDPOINT_URL,
  'AGENT_ENDPOINT_URL',
);
const noRedirectFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, redirect: 'error' });

async function createMyAgentClient(): Promise<A2XClient> {
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

  // EnvAuthProvider's endpoint, client ID, audience/resource, and scope
  // allowlists are deployment policy for this exact card+endpoint tuple.
  return new A2XClient(resolved.card, {
    fetch: noRedirectFetch,
    authProvider: new EnvAuthProvider(),
  });
}

export const myAgentClientPromise = createMyAgentClient();
```

Await `myAgentClientPromise` during startup before accepting work. This prevents token exchange or attachment until the card URL and resolved A2A endpoint match policy; the no-redirect fetch prevents a trusted URL from silently moving either discovery or requests elsewhere. Reuse one `A2XClient` per remote agent and credential identity. It caches the card and resolved schemes, while each request builds its own transport state. Do not share a client across users, mutate its extension set during concurrent calls, or share an x402 client without following the payment storage and reconciliation requirements.

### Watch out for

- **First call races.** If multiple requests arrive simultaneously and `_ensureAuthenticated` hasn't run yet, they will all enter `provide()` in parallel. Deduplicate only the underlying token exchange, then fill and return the `AuthScheme` instances supplied to each invocation:

  ```typescript
  private tokenInflight?: Promise<string>;

  async provide(requirements: AuthScheme[][]): Promise<AuthScheme[]> {
    const group = requirements.find(group =>
      group.length === 1 && group[0] instanceof OAuth2ClientCredentialsAuthScheme,
    );
    if (!group) throw new Error('No supported authentication group');

    this.tokenInflight ??= this.exchangeToken()
      .finally(() => { this.tokenInflight = undefined; });
    group[0].setCredential(await this.tokenInflight);
    return group;
  }
  ```

  Never cache or return one invocation's `AuthScheme[]` from another invocation: the client expects the exact instances it passed to the provider. `A2XClient` itself does not dedupe, so providers must make credential acquisition concurrency-safe.

- **Stale token caches across restarts.** If you roll out a new deploy, the new process starts with an empty `_resolvedSchemes` and calls `provide()` again. That's fine for client_credentials (re-exchange is cheap) but could be a problem for pre-fetched secrets with rate limits.

---

## Horizontal x402 Ownership

For paid calls, use a durable queue/actor partitioned by `(agent URL, payer identity)` with exactly one active consumer for the complete sign → submit → terminal receipt/reconciliation lifecycle. A load-balancer affinity cookie or short expiring lock is not sufficient.

Do not treat `X402ClientChannelStorage` as a distributed lock: its public contract exposes only `get`, `set`, and `delete`, not compare-and-set. If ownership must move after a crash, let the coordinator assign a monotonically increasing generation without overlapping owners. The successor must load the pending task/attempt and reconcile or quarantine it before signing again. A database-backed storage adapter can reject stale generations on every method, but that alone cannot fence an already-started HTTP submission; non-overlapping queue ownership is the primary safety boundary.

The worker—not an HTTP client connection—owns a paid stream after submission. It must drain the stream to a terminal state or reconcile/quarantine the payment even if the browser disconnects. Persist sanitized events and let browsers subscribe to a replayable stream.

---

## Token Caching with TTL (Optional)

For OAuth2 flows, cache the exchanged token so repeated restarts within the token's lifetime don't re-hit the token endpoint:

```typescript
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL!);

// Implement with trusted JWT verification or token introspection. Decoding a
// JWT without signature/issuer validation is not sufficient.
declare function assertTokenAudience(
  token: string,
  expectedAudience: string,
): Promise<void>;

async function getCachedOrExchange(
  scheme: OAuth2ClientCredentialsAuthScheme,
  agentEndpoint: string,
  clientIdentity: string,
  expectedAudience: string,
): Promise<string> {
  const tokenUrl = trustedOAuthEndpoint(scheme.params.tokenUrl, 'token endpoint');
  const scopes = approvedScope(
    scheme.params.scopes,
    scheme.params.requiredScopes,
  )
    .split(' ')
    .filter(Boolean)
    .sort()
    .join(' ');
  // clientIdentity is a stable public ID (client/tenant), never the secret.
  const key = `a2a:${JSON.stringify([
    agentEndpoint,
    tokenUrl.toString(),
    clientIdentity,
    expectedAudience,
    scopes,
  ])}`;
  const cached = await redis.get(key);
  if (cached) {
    await assertTokenAudience(cached, expectedAudience);
    return cached;
  }

  const clientId = process.env.OAUTH_CLIENT_ID;
  const clientSecret = process.env.OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('OAuth client is incomplete');
  const res = await fetch(tokenUrl, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      ...(scopes ? { scope: scopes } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: HTTP ${res.status}`);
  const { access_token, expires_in = 3600, scope } = await res.json() as {
    access_token?: string;
    expires_in?: number;
    scope?: string;
  };
  if (!access_token) throw new Error('Token response omitted access_token');
  assertGrantedScope(scope);
  await assertTokenAudience(access_token, expectedAudience);
  // Cache for 90% of the advertised lifetime to avoid edge-of-expiry races
  const ttl = Number.isFinite(expires_in) && expires_in > 0
    ? Math.max(1, Math.floor(expires_in * 0.9))
    : 3600;
  await redis.set(key, access_token, 'EX', ttl);
  return access_token;
}
```

Use it as the OAuth branch of `resolveCredential`:

```typescript
if (scheme instanceof OAuth2ClientCredentialsAuthScheme) {
  const credentialIdentity = process.env.OAUTH_CREDENTIAL_ID;
  const agentEndpoint = process.env.AGENT_ENDPOINT_URL;
  const audience = process.env.OAUTH_EXPECTED_AUDIENCE;
  if (!credentialIdentity || !agentEndpoint || !audience) return undefined;
  return getCachedOrExchange(
    scheme,
    agentEndpoint,
    credentialIdentity, // stable public client+tenant label
    audience,
  );
}
```

---

## Card Preflight at Startup

Resolve the policy-bound client at boot so discovery and routing failures surface before the process accepts traffic:

```typescript
// src/main.ts
import { myAgentClientPromise } from './agents/my-agent-client.js';

(async () => {
  try {
    const myAgentClient = await myAgentClientPromise;
    await myAgentClient.getAgentCard(); // already fetched and endpoint-checked
  } catch (err) {
    console.error('Agent client preflight failed:', err);
    process.exit(1);
  }
  // start server
})();
```

`getAgentCard()` does not invoke `AuthProvider.provide()`. The factory above nevertheless validates the exact card+endpoint boundary before any provider can exchange or attach a token. Test authentication separately by normalizing the card's requirements and calling the provider, or perform an authenticated operation whose effects are safe in your environment. A cache or provider created for one tuple must never be reused after any tuple field changes.

---

## Secret Manager Integration

Same shape, different source:

```typescript
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const secretsClient = new SecretsManagerClient({});

async function getSecret(name: string): Promise<string | undefined> {
  try {
    const { SecretString } = await secretsClient.send(
      new GetSecretValueCommand({ SecretId: name }),
    );
    return SecretString;
  } catch {
    return undefined;
  }
}

const API_KEY_SECRET_BY_SLOT: Record<string, string | undefined> = {
  'header:x-api-key': 'agent/api-key',
  'header:x-tenant-key': 'agent/tenant-key',
};

// Inside a slot-aware async equivalent of fillStatic:
if (scheme instanceof ApiKeyAuthScheme) {
  const secretName = API_KEY_SECRET_BY_SLOT[apiKeySlot(scheme)];
  if (!secretName) return false;
  const key = await getSecret(secretName);
  if (!key) return false;
  scheme.setCredential(key);
  return true;
}
```

Cache the secret at application startup if you call it frequently — Secrets Manager has per-account rate limits.

---

## Retries and Circuit Breaking

Wrap outgoing agent calls in a retry + circuit breaker for production reliability:

```typescript
import CircuitBreaker from 'opossum';

const breaker = new CircuitBreaker(
  (params: SendMessageParams) => myAgentClient.sendMessage(params),
  {
    timeout: 30_000,
    errorThresholdPercentage: 50,
    resetTimeout: 30_000,
  },
);

breaker.fallback(() => ({ error: 'agent_unavailable' } as const));

const result = await breaker.fire(params);
```

Retry `getTask` when appropriate. After an ambiguous `cancelTask` failure, read the task before retrying because the cancellation may already have succeeded. `sendMessage` should generally **not** be retried automatically.

---

## Logging and Observability

Backend contexts almost always want structured logging. Emit per-call metadata:

```typescript
import pino from 'pino';
const log = pino();

async function callAgent(params: SendMessageParams) {
  const start = Date.now();
  try {
    const task = await myAgentClient.sendMessage(params);
    log.info({
      agent: process.env.AGENT_URL,
      method: 'sendMessage',
      taskId: task.id,
      state: task.status?.state,
      durationMs: Date.now() - start,
    }, 'agent call ok');
    return task;
  } catch (err) {
    log.error({
      agent: process.env.AGENT_URL,
      method: 'sendMessage',
      err: err instanceof Error ? { name: err.name, message: err.message } : err,
      durationMs: Date.now() - start,
    }, 'agent call failed');
    throw err;
  }
}
```

Never log `params.message.parts` verbatim if user content is sensitive.
