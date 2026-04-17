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

export class EnvAuthProvider implements AuthProvider {
  async provide(requirements: AuthScheme[][]): Promise<AuthScheme[]> {
    for (const group of requirements) {
      if (await this.tryFill(group)) return group;
    }
    throw new Error(
      'No configured credentials match the agent security requirements. ' +
      'Set AGENT_API_KEY, AGENT_BEARER_TOKEN, or OAUTH_CLIENT_* env vars.',
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

  const res = await fetch(scheme.params.tokenUrl, {
    method: 'POST',
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

`A2XClient` is safe to share: the `fetch` call is stateless, and the only mutable state (`_resolvedSchemes`) is set once. Concurrent requests will all go through the same already-authenticated schemes.

### Watch out for

- **First call races.** If multiple requests arrive simultaneously and `_ensureAuthenticated` hasn't run yet, they will all enter `provide()` in parallel. For `AuthProvider`s that do expensive work (OAuth2 token exchange), add your own in-flight-promise dedupe:

  ```typescript
  private inflight?: Promise<AuthScheme[]>;

  async provide(requirements: AuthScheme[][]): Promise<AuthScheme[]> {
    this.inflight ??= this.doProvide(requirements)
      .finally(() => { this.inflight = undefined; });
    return this.inflight;
  }
  ```

  Note: `A2XClient` itself does not dedupe — it relies on the provider to be idempotent-enough.

- **Stale token caches across restarts.** If you roll out a new deploy, the new process starts with an empty `_resolvedSchemes` and calls `provide()` again. That's fine for client_credentials (re-exchange is cheap) but could be a problem for pre-fetched secrets with rate limits.

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
  const key = `a2a:${agentUrl}:${scheme.constructor.name}`;
  const cached = await redis.get(key);
  if (cached) return cached;

  const res = await fetch(scheme.params.tokenUrl, { /* … */ });
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

## Fail-Fast at Startup

Consider probing the agent at boot so misconfiguration surfaces immediately, not on the first request:

```typescript
// src/main.ts
import { myAgentClient } from './agents/my-agent-client.js';

(async () => {
  try {
    await myAgentClient.getAgentCard(); // triggers card fetch + auth resolution
  } catch (err) {
    console.error('Agent client preflight failed:', err);
    process.exit(1);
  }
  // start server
})();
```

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

// Inside fillStatic:
if (scheme instanceof ApiKeyAuthScheme) {
  const key = await getSecret('agent/api-key');
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

Only protect **idempotent** operations (`getTask`, `cancelTask`) or operations where re-sending is tolerable. `sendMessage` should generally **not** be retried automatically.

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
