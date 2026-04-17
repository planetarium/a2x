# OAuth2 Device Code Flow

The SDK hands you an `OAuth2DeviceCodeAuthScheme` with the endpoints and scopes; running the flow is **your** responsibility. This is the implementation lifted from `packages/cli/src/cli-auth-provider.ts`.

---

## When to Use

`OAuth2DeviceCodeAuthScheme` is the right choice for **headless** or **no-browser** clients:

- CLIs on a server where you can't pop a browser
- Kiosk apps / embedded devices
- Containers / SSH sessions

The SDK only ever constructs this scheme when the agent card (v1.0) declares a `deviceCode` flow (v0.3 does not define device-code).

---

## Flow Summary

```
Client                                              Authorization Server
  │                                                        │
  │  POST deviceAuthorizationUrl                           │
  │  scope=<space-delimited-scopes>                        │
  │ ──────────────────────────────────────────────────────▶│
  │                                                        │
  │  { device_code, user_code, verification_uri, [...] }   │
  │ ◀──────────────────────────────────────────────────────│
  │                                                        │
  │  [display user_code + verification_uri]                │
  │  [user opens browser, enters code, authorizes]         │
  │                                                        │
  │  POST tokenUrl                                         │
  │  grant_type=urn:ietf:params:oauth:grant-type:device_code│
  │  device_code=<code>                                    │
  │ ──────────────────────────────────────────────────────▶│
  │                                                        │
  │  either { error: 'authorization_pending' }             │
  │  or     { error: 'slow_down' }                         │
  │  or     { access_token, ... }   ← terminal             │
  │ ◀──────────────────────────────────────────────────────│
  │                                                        │
  │  [repeat POST /token every `interval` seconds]         │
  │  [until access_token or expires_in elapses]            │
```

---

## Reference Implementation

```typescript
import type { OAuth2DeviceCodeAuthScheme } from '@a2x/sdk/client';

interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in?: number;     // seconds
  interval?: number;       // seconds — poll cadence
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

interface TokenErrorResponse {
  error: string;
  error_description?: string;
}

export async function performDeviceCodeFlow(
  scheme: OAuth2DeviceCodeAuthScheme,
): Promise<string> {
  const { deviceAuthorizationUrl, tokenUrl, scopes } = scheme.params;

  // Step 1: Request a device code
  const scopeStr = Object.keys(scopes).join(' ');
  const deviceRes = await fetch(deviceAuthorizationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      ...(scopeStr ? { scope: scopeStr } : {}),
    }),
  });

  if (!deviceRes.ok) {
    throw new Error(
      `Device authorization failed: HTTP ${deviceRes.status} ${deviceRes.statusText}`,
    );
  }

  const deviceData = (await deviceRes.json()) as DeviceAuthResponse;
  const pollInterval = (deviceData.interval ?? 5) * 1000;

  // Step 2: Display instructions to the user
  console.log('');
  console.log('  To authenticate, visit:');
  console.log(`  ${deviceData.verification_uri_complete ?? deviceData.verification_uri}`);
  if (!deviceData.verification_uri_complete) {
    console.log(`  and enter code: ${deviceData.user_code}`);
  }
  console.log('');
  process.stdout.write('  Waiting for authorization...');

  // Step 3: Poll the token endpoint
  const deadline = Date.now() + (deviceData.expires_in ?? 300) * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollInterval));

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceData.device_code,
      }),
    });

    const tokenData = (await tokenRes.json()) as TokenResponse | TokenErrorResponse;

    if ('access_token' in tokenData) {
      console.log(' Authorized!');
      return tokenData.access_token;
    }

    const errorData = tokenData as TokenErrorResponse;
    if (errorData.error === 'authorization_pending') {
      process.stdout.write('.');
      continue;
    }
    if (errorData.error === 'slow_down') {
      await new Promise(r => setTimeout(r, pollInterval));  // extra back-off
      continue;
    }

    console.log(' Failed');
    throw new Error(
      errorData.error_description ?? errorData.error ?? 'Token request failed',
    );
  }

  console.log(' Expired');
  throw new Error('Device code expired before authorization was completed');
}
```

Use it from `resolveScheme`:

```typescript
if (scheme instanceof OAuth2DeviceCodeAuthScheme) {
  const token = await performDeviceCodeFlow(scheme);
  scheme.setCredential(token);
  return;
}
```

---

## Handling the Error Codes

The OAuth2 Device Authorization Grant spec ([RFC 8628 §3.5](https://datatracker.ietf.org/doc/html/rfc8628#section-3.5)) defines these terminal and non-terminal errors from the token endpoint:

| Error | Meaning | CLI behavior |
|-------|---------|--------------|
| `authorization_pending` | User hasn't approved yet. Keep polling. | Continue loop. |
| `slow_down` | Polling too fast. Increase interval by ≥5s. | Extra sleep, continue. |
| `access_denied` | User rejected the request. | Fatal, throw. |
| `expired_token` | Device code passed its `expires_in`. | Fatal, throw. |
| (any other) | Protocol error. | Fatal, throw. |

The CLI catches `authorization_pending` and `slow_down` and treats **every other** error as fatal — including unknown ones. That matches the spec: only those two are non-terminal.

---

## Client Authentication on the Token Endpoint

Some authorization servers require the client to authenticate on the token endpoint even during device-code polling (`client_id` / `client_secret`). The reference above omits them — add them if your authorization server requires them:

```typescript
body: new URLSearchParams({
  grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  device_code: deviceData.device_code,
  client_id: process.env.OAUTH_CLIENT_ID!,
  // client_secret: process.env.OAUTH_CLIENT_SECRET!,  // only for confidential clients
}),
```

The device-code flow is typically used with **public** clients (no secret), so `client_id` is usually enough. Consult your agent's OAuth2 server docs.

---

## Storing the Access Token

The access token goes into the store via `saveCredentials` keyed by `scheme.constructor.name === 'OAuth2DeviceCodeAuthScheme'`. On subsequent runs, the CLI restores it with `scheme.setCredential` — no new device-code flow.

If you want to also store `refresh_token` and run a token refresh on 401 instead of re-doing the device-code flow, extend `StoredCredential`:

```typescript
interface StoredCredential {
  schemeClass: string;
  credential: string;
  refreshCredential?: string;  // OAuth2 refresh_token
  expiresAt?: number;
}
```

Then in `AuthProvider.refresh()`, try the refresh token before falling back to `performDeviceCodeFlow`:

```typescript
async refresh(schemes: AuthScheme[]): Promise<AuthScheme[]> {
  for (const scheme of schemes) {
    if (scheme instanceof OAuth2DeviceCodeAuthScheme) {
      const rt = loadRefreshToken(this.agentUrl);
      if (rt) {
        const ok = await tryRefreshToken(scheme.params.tokenUrl, rt, scheme);
        if (ok) continue;
      }
      // fall back to a fresh device-code flow
      const token = await performDeviceCodeFlow(scheme);
      scheme.setCredential(token);
    } else {
      await resolveScheme(scheme);
    }
  }
  this._save(schemes);
  return schemes;
}

async function tryRefreshToken(
  tokenUrl: string,
  refreshToken: string,
  scheme: OAuth2DeviceCodeAuthScheme,
): Promise<boolean> {
  const res = await fetch(tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });
  if (!res.ok) return false;
  const data = (await res.json()) as TokenResponse | TokenErrorResponse;
  if (!('access_token' in data)) return false;
  scheme.setCredential(data.access_token);
  return true;
}
```

---

## UX Notes

- `verification_uri_complete` (when the server provides it) embeds the user code in the URL — the user only clicks the link. Prefer it.
- Print the URL on its own line so terminal emulators auto-linkify it.
- Print the `user_code` in a visually distinct way (color, spacing) — users frequently mistype.
- A live progress indicator (`.` per poll) reassures the user the CLI is still working. The reference implementation does this.

---

## Cancellation

The reference loop has no cancellation hook. If you want the user to be able to hit Ctrl-C cleanly:

```typescript
const ac = new AbortController();
process.once('SIGINT', () => ac.abort());

while (Date.now() < deadline) {
  if (ac.signal.aborted) throw new Error('Cancelled');
  await new Promise((resolve, reject) => {
    const t = setTimeout(resolve, pollInterval);
    ac.signal.addEventListener('abort', () => {
      clearTimeout(t);
      reject(new Error('Cancelled'));
    }, { once: true });
  });
  // …
}
```

Be careful not to leak the `SIGINT` listener between invocations.
