# Token Persistence

How to persist credentials across process restarts so users don't re-authenticate on every invocation. Reference implementation: `packages/cli/src/token-store.ts`.

---

## File-Based Store (CLI Pattern)

The CLI stores credentials in `~/.a2x/tokens.json`, keyed by agent URL:

```json
{
  "https://agent.example.com": [
    { "schemeClass": "ApiKeyAuthScheme", "credential": "sk-abc123..." }
  ],
  "https://other.example.com/a2a": [
    { "schemeClass": "HttpBearerAuthScheme", "credential": "eyJhbGci..." }
  ]
}
```

Full implementation, one file:

```typescript
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STORE_DIR = path.join(os.homedir(), '.myapp');
const STORE_PATH = path.join(STORE_DIR, 'tokens.json');

interface StoredCredential {
  schemeClass: string;
  credential: string;
}

type StoreData = Record<string, StoredCredential[]>;

function readStore(): StoreData {
  try {
    return JSON.parse(fs.readFileSync(STORE_PATH, 'utf-8')) as StoreData;
  } catch {
    return {};
  }
}

function writeStore(data: StoreData): void {
  fs.mkdirSync(STORE_DIR, { recursive: true });
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), 'utf-8');
}

export function loadCredentials(agentUrl: string): StoredCredential[] | undefined {
  return readStore()[agentUrl];
}

export function saveCredentials(agentUrl: string, credentials: StoredCredential[]): void {
  const store = readStore();
  store[agentUrl] = credentials;
  writeStore(store);
}

export function clearCredentials(agentUrl: string): void {
  const store = readStore();
  delete store[agentUrl];
  writeStore(store);
}
```

---

## Agent URL as the Key

The CLI uses the exact string the user typed as the agent URL (e.g. `http://localhost:3000`, `https://agent.example.com`, `https://agent.example.com/.well-known/agent.json`). This is deliberate:

- No canonicalization → two different aliases for the same agent get two different entries, which is fine because any group that works for one works for the other (same card, same schemes).
- Avoids DNS lookups or URL-parse edge cases (trailing slashes, default ports) from silently deduplicating entries.

If you want canonicalization, do it explicitly and consistently:

```typescript
function canonicalKey(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.host}`;   // origin only, drop path/query
}
```

Just be aware: if two agents share an origin but have different cards (different paths), you'll conflate their credentials.

---

## Extracting the Credential

`AuthScheme` keeps `credential` as a `protected` field — there's no getter. The reference pattern is to invoke `applyToRequest` against a dummy context and read the credential back out:

```typescript
import {
  AuthScheme,
  ApiKeyAuthScheme,
} from '@a2x/sdk/client';

export function extractCredential(scheme: AuthScheme): {
  schemeClass: string;
  credential: string;
} {
  const ctx = {
    headers: {} as Record<string, string>,
    url: new URL('http://dummy'),
  };
  scheme.applyToRequest(ctx);

  let credential = '';
  const className = scheme.constructor.name;

  if (scheme instanceof ApiKeyAuthScheme) {
    credential = ctx.headers[scheme.params.name]
      ?? ctx.url.searchParams.get(scheme.params.name)
      ?? '';
  } else {
    // Bearer-style: "Bearer <token>" or "Basic <base64>"
    const auth = ctx.headers['Authorization'] ?? '';
    const spaceIdx = auth.indexOf(' ');
    credential = spaceIdx >= 0 ? auth.slice(spaceIdx + 1) : auth;
  }

  return { schemeClass: className, credential };
}
```

Why this works:

- Every scheme has a defined `applyToRequest` that mutates the context.
- API keys may land in `headers[name]`, `url.searchParams`, or `Cookie` — the `ApiKeyAuthScheme` branch handles header/query; cookie-placed keys would need an extra branch. The CLI does not handle cookie placement today, but the pattern extends cleanly.
- All other schemes (Bearer, Basic, OAuth2 variants, OIDC) place credentials in `Authorization` with a `<scheme> <value>` format — strip the prefix.

### Handling cookie-based API keys (extension)

```typescript
if (scheme instanceof ApiKeyAuthScheme) {
  if (scheme.params.location === 'cookie') {
    const cookieHeader = ctx.headers['Cookie'] ?? '';
    const match = cookieHeader.match(new RegExp(`${scheme.params.name}=([^;]*)`));
    credential = match?.[1] ?? '';
  } else {
    credential = ctx.headers[scheme.params.name]
      ?? ctx.url.searchParams.get(scheme.params.name)
      ?? '';
  }
}
```

---

## Security Considerations

The CLI's `~/.a2x/tokens.json` is:

- **world-readable by default** on Unix (file is created with `0644`).
- **plaintext** — anyone with filesystem access can copy tokens.
- **unencrypted** at rest.

This is acceptable for a developer CLI on a personal machine; it is **not** acceptable for anything approaching production. Options for a production-grade store:

| Backend | Notes |
|---------|-------|
| OS keychain (`keytar`, macOS Keychain, Windows Credential Manager, libsecret) | Per-user, OS-managed. Best default. |
| AWS Secrets Manager / HashiCorp Vault | For server-side clients; pull at startup or per-request. |
| Encrypted file (libsodium / GPG) | If you must use a file; add a passphrase prompt. |
| In-memory only | Forfeits step 1 of the fallback chain, but safest. Suitable for short-lived workers. |

When switching stores, keep the same shape — `Record<agentUrl, Array<{ schemeClass, credential }>>` — and only swap the backing read/write functions. The `AuthProvider` doesn't need to know.

### Permissions hardening (file store)

If you stick with a file store, tighten permissions:

```typescript
function writeStore(data: StoreData): void {
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}
```

On re-write of an existing file, `mode` only affects creation; explicitly `chmod` if you want to enforce it:

```typescript
fs.chmodSync(STORE_PATH, 0o600);
```

Windows: `mode` is largely ignored; rely on the user's home-directory ACLs.

### What to never log

- Full `Authorization` header
- Raw credential values
- Response bodies from token endpoints (contain `access_token` / `refresh_token`)

Safe: scheme class names, agent URLs, `scheme.params.name` for API keys.

---

## Refresh vs. Invalidate

`refresh()` in the CLI is an **invalidate + re-prompt** flow:

```typescript
async refresh(schemes: AuthScheme[]): Promise<AuthScheme[]> {
  clearCredentials(this.agentUrl);
  for (const scheme of schemes) await resolveScheme(scheme);
  this._save(schemes);
  return schemes;
}
```

It does not call any OAuth2 `refresh_token` endpoint, even for schemes that provide a `refreshUrl`. For a smarter refresh, handle OAuth2 schemes specially:

```typescript
async refresh(schemes: AuthScheme[]): Promise<AuthScheme[]> {
  for (const scheme of schemes) {
    if (scheme instanceof OAuth2DeviceCodeAuthScheme && scheme.params.refreshUrl) {
      const refreshed = await tryRefreshToken(scheme.params.refreshUrl, loadRefreshToken(...));
      if (refreshed) {
        scheme.setCredential(refreshed.access_token);
        saveRefreshToken(refreshed.refresh_token);
        continue;
      }
    }
    // Fall back to re-prompt
    await resolveScheme(scheme);
  }
  this._save(schemes);
  return schemes;
}
```

Supporting `refresh_token` requires storing it too — extend `StoredCredential` with an optional `refreshCredential` field.

---

## TTL / Expiry Tracking

The CLI does not track TTLs — stored tokens live until `refresh()` clears them. If you want proactive expiry:

```typescript
interface StoredCredential {
  schemeClass: string;
  credential: string;
  expiresAt?: number;    // Unix ms
}

export function loadCredentials(agentUrl: string): StoredCredential[] | undefined {
  const entries = readStore()[agentUrl];
  if (!entries) return undefined;
  const now = Date.now();
  const fresh = entries.filter(e => !e.expiresAt || e.expiresAt > now + 30_000);
  return fresh.length === entries.length ? entries : undefined;
}
```

Token endpoints return `expires_in` (seconds) — convert to `Date.now() + expires_in * 1000` on save.

---

## Clearing Credentials on Demand

Expose a "logout" path your UI can call:

```typescript
import { clearCredentials } from './token-store.js';

program
  .command('logout <url>')
  .description('Clear stored credentials for an agent')
  .action((url: string) => {
    clearCredentials(url);
    console.log('Cleared credentials for', url);
  });
```

Also consider a `logout --all` that wipes the entire file — useful when switching machines or rotating everything.
