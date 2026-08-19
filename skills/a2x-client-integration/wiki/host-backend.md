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

const API_KEY_ENV_BY_SLOT: Record<string, string | undefined> = {
  'header:x-api-key': process.env.AGENT_API_KEY,
  'header:x-tenant-key': process.env.AGENT_TENANT_API_KEY,
};

const TRUSTED_OAUTH_ORIGINS = new Set(
  (process.env.OAUTH_ISSUER_ORIGINS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => new URL(value).origin),
);

function trustedOAuthEndpoint(raw: string, purpose: string): URL {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || !TRUSTED_OAUTH_ORIGINS.has(url.origin)) {
    throw new Error(`Refusing untrusted OAuth ${purpose} origin: ${url.origin}`);
  }
  return url;
}

function apiKeySlot(scheme: ApiKeyAuthScheme): string {
  const name = scheme.params.location === 'header'
    ? scheme.params.name.toLowerCase()
    : scheme.params.name;
  return `${scheme.params.location}:${name}`;
}

export class EnvAuthProvider implements AuthProvider {
  async provide(requirements: AuthScheme[][]): Promise<AuthScheme[]> {
    for (const group of requirements) {
      if (await this.tryFill(group)) return group;
    }
    throw new Error(
      'No configured credentials match the agent security requirements. ' +
      'Configure the required API-key slots, AGENT_BEARER_TOKEN, or OAUTH_CLIENT_* env vars.',
    );
  }

  async refresh(schemes: AuthScheme[]): Promise<AuthScheme[]> {
    // For OAuth2 client_credentials, re-exchange.
    // For static API key / Bearer, re-reading env is usually pointless —
    // but if the env was rotated since startup, this picks it up.
    for (const scheme of schemes) {
      if (scheme instanceof OAuth2ClientCredentialsAuthScheme) {
        await fillClientCredentials(scheme);
      } else {
        await fillStatic(scheme);
      }
    }
    return schemes;
  }

  private async tryFill(group: AuthScheme[]): Promise<boolean> {
    for (const scheme of group) {
      const ok = scheme instanceof OAuth2ClientCredentialsAuthScheme
        ? await fillClientCredentials(scheme)
        : fillStatic(scheme);
      if (!ok) return false;
    }
    return true;
  }
}

function fillStatic(scheme: AuthScheme): boolean {
  if (scheme instanceof ApiKeyAuthScheme) {
    const key = API_KEY_ENV_BY_SLOT[apiKeySlot(scheme)];
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
  if (scheme instanceof HttpBasicAuthScheme) {
    const user = process.env.AGENT_BASIC_USER;
    const pass = process.env.AGENT_BASIC_PASS;
    if (!user || !pass) return false;
    scheme.setCredential(Buffer.from(`${user}:${pass}`).toString('base64'));
    return true;
  }
  return false;
}

async function fillClientCredentials(
  scheme: OAuth2ClientCredentialsAuthScheme,
): Promise<boolean> {
  const clientId = process.env.OAUTH_CLIENT_ID;
  const clientSecret = process.env.OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) return false;

  // Agent-card discovery is not a trust decision. Validate before sending secrets.
  const tokenUrl = trustedOAuthEndpoint(scheme.params.tokenUrl, 'token endpoint');
  const res = await fetch(tokenUrl, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
      scope: Object.keys(scheme.params.scopes).join(' '),
    }),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as { access_token?: string };
  if (!data.access_token) return false;
  scheme.setCredential(data.access_token);
  return true;
}
```

Configure `OAUTH_ISSUER_ORIGINS` from deployment policy, for example `https://login.example.com`; do not derive it from the agent card. Add an explicit development-only exception if local HTTP identity infrastructure is unavoidable. Redirects are rejected because an otherwise trusted endpoint could redirect the client secret to another origin.

API-key slots are keyed by placement and name because a valid AND group can require several distinct API keys. Add every expected slot to `API_KEY_ENV_BY_SLOT`; do not reuse one environment variable for the whole class.

---

## Client Lifetime

A long-lived backend should create the client **once** at startup and reuse it:

```typescript
// src/agents/my-agent-client.ts
import { A2XClient } from '@a2x/sdk/client';
import { EnvAuthProvider } from './env-auth-provider.js';

export const myAgentClient = new A2XClient(process.env.AGENT_URL!, {
  authProvider: new EnvAuthProvider(),
});
```

Reuse one `A2XClient` per remote agent and credential identity. It caches the card and resolved schemes, while each request builds its own transport state. Do not share a client across users, mutate its extension set during concurrent calls, or share an x402 client without following the payment storage and reconciliation requirements.

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

For paid calls, route each `(agent URL, payer identity, payment channel)` to one durable owner for the complete sign → submit → terminal receipt/reconciliation lifecycle. A load-balancer affinity cookie is not sufficient.

If ownership can move between workers, store a monotonically increasing fencing token with the reservation in a transactional database. Every sign, submit, reconciliation, and quarantine write must compare-and-set that token and reject stale owners. A short expiring lock by itself can allow two workers to spend after a pause or network partition.

The worker—not an HTTP client connection—owns a paid stream after submission. It must drain the stream to a terminal state or reconcile/quarantine the payment even if the browser disconnects. Persist sanitized events and let browsers subscribe to a replayable stream.

---

## Token Caching with TTL (Optional)

For OAuth2 flows, cache the exchanged token so repeated restarts within the token's lifetime don't re-hit the token endpoint:

```typescript
import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL!);

async function getCachedOrExchange(
  scheme: OAuth2ClientCredentialsAuthScheme,
  agentUrl: string,
): Promise<string> {
  const scopes = Object.keys(scheme.params.scopes).sort().join(' ');
  const key = `a2a:${agentUrl}:${scheme.params.tokenUrl}:${scopes}`;
  const cached = await redis.get(key);
  if (cached) return cached;

  const tokenUrl = trustedOAuthEndpoint(scheme.params.tokenUrl, 'token endpoint');
  const res = await fetch(tokenUrl, { redirect: 'error', /* … */ });
  const { access_token, expires_in = 3600 } = await res.json() as {
    access_token: string;
    expires_in?: number;
  };
  // Cache for 90% of the advertised lifetime to avoid edge-of-expiry races
  await redis.set(key, access_token, 'EX', Math.floor(expires_in * 0.9));
  return access_token;
}
```

Apply inside `tryFill`:

```typescript
if (scheme instanceof OAuth2ClientCredentialsAuthScheme) {
  const token = await getCachedOrExchange(scheme, this.agentUrl);
  scheme.setCredential(token);
  return true;
}
```

---

## Card Preflight at Startup

Consider probing the agent card at boot so discovery and routing failures surface immediately, not on the first request:

```typescript
// src/main.ts
import { myAgentClient } from './agents/my-agent-client.js';

(async () => {
  try {
    await myAgentClient.getAgentCard(); // triggers card fetch only
  } catch (err) {
    console.error('Agent client preflight failed:', err);
    process.exit(1);
  }
  // start server
})();
```

`getAgentCard()` does not invoke `AuthProvider.provide()`. Test authentication separately by normalizing the card's requirements and calling the provider, or perform an authenticated operation whose effects are safe in your environment.

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
