# OAuth2 Device Code Flow

The SDK hands you an `OAuth2DeviceCodeAuthScheme` with the endpoints and scopes; running the flow is **your** responsibility. The implementation below is based on `packages/cli/src/cli-auth-provider.ts` and adds an origin allowlist because agent-card discovery metadata is not a trust anchor.

---

## When to Use

`OAuth2DeviceCodeAuthScheme` is the right choice for **headless** or **no-browser** clients:

- CLIs on a server where you can't pop a browser
- Kiosk apps / embedded devices
- Containers / SSH sessions

Device Code is native to an A2A v1.0 AgentCard. The SDK also consumes the non-standard `deviceCode` flow emitted by a2x v0.3 cards for compatibility; third-party v0.3 implementations may ignore that extension.

---

## Flow Summary

```
Client                                              Authorization Server
  │                                                        │
  │  POST deviceAuthorizationUrl                           │
  │  client_id=<host-configured-client>                    │
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
  │  client_id=<host-configured-client>                    │
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

function assertBearerTokenType(tokenType: string): void {
  if (typeof tokenType !== 'string' || tokenType.toLowerCase() !== 'bearer') {
    throw new Error('Token endpoint returned a non-Bearer token type');
  }
}

function normalizeOAuthEndpoint(raw: string): string {
  const url = new URL(raw);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new Error(`Invalid OAuth endpoint: ${url.origin}`);
  }
  return url.toString();
}

// One exact identity policy belongs to one approved card+agent endpoint tuple.
// Never pool endpoints from several agents: a hostile card could select another
// entry and receive this tuple's device code, refresh token, or client secret.
const OAUTH_POLICY = Object.freeze({
  deviceAuthorizationEndpoint: normalizeOAuthEndpoint(
    process.env.OAUTH_DEVICE_AUTHORIZATION_ENDPOINT!,
  ),
  tokenEndpoint: normalizeOAuthEndpoint(process.env.OAUTH_TOKEN_ENDPOINT!),
  refreshEndpoint: normalizeOAuthEndpoint(
    process.env.OAUTH_REFRESH_ENDPOINT ?? process.env.OAUTH_TOKEN_ENDPOINT!,
  ),
  clientId: process.env.OAUTH_CLIENT_ID!,
  expectedAudience: process.env.OAUTH_EXPECTED_AUDIENCE!,
  allowedScopes: new Set(
    (process.env.OAUTH_ALLOWED_SCOPES ?? '').split(/\s+/).filter(Boolean),
  ),
});

const TRUSTED_VERIFICATION_ORIGINS = new Set(
  (process.env.OAUTH_VERIFICATION_ORIGINS ?? '')
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => new URL(value).origin),
);

function trustedOAuthEndpoint(
  raw: string,
  expected: string,
  purpose: string,
): URL {
  const normalized = normalizeOAuthEndpoint(raw);
  if (normalized !== expected) {
    throw new Error(`Refusing untrusted OAuth ${purpose}: ${normalized}`);
  }
  return new URL(normalized);
}

function trustedVerificationUrl(raw: string): URL {
  const url = new URL(raw);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    !TRUSTED_VERIFICATION_ORIGINS.has(url.origin)
  ) {
    throw new Error(`Refusing untrusted verification URL: ${url.origin}`);
  }
  return url;
}

function approvedScope(
  advertised: Record<string, string>,
  required: readonly string[] | undefined,
): string {
  if (!required) {
    throw new Error('OAuth requirement omitted requiredScopes');
  }
  const requested = [...new Set(required)];
  const rejected = requested.filter(scope =>
    !(scope in advertised) || !OAUTH_POLICY.allowedScopes.has(scope)
  );
  if (rejected.length) {
    throw new Error(`Refusing unapproved OAuth scopes: ${rejected.join(', ')}`);
  }
  return requested.join(' ');
}

function assertGrantedScope(
  granted: string | undefined,
  requested: readonly string[],
): void {
  if (!granted) return;
  const grantedSet = new Set(granted.split(/\s+/).filter(Boolean));
  const requestedSet = new Set(requested);
  const unexpected = [...grantedSet].filter(scope => !requestedSet.has(scope));
  const missing = [...requestedSet].filter(scope => !grantedSet.has(scope));
  if (unexpected.length || missing.length) {
    throw new Error(
      `Token scope mismatch (unexpected: ${unexpected.join(', ') || 'none'}; ` +
      `missing: ${missing.join(', ') || 'none'})`,
    );
  }
}

// Implement with trusted JWT verification or token introspection. Verify
// issuer, audience/resource, and exact scopes; never trust decode-only claims.
declare function assertTokenPolicy(
  token: string,
  expectedAudience: string,
  requestedScopes: readonly string[],
): Promise<void>;

export async function performDeviceCodeFlow(
  scheme: OAuth2DeviceCodeAuthScheme,
  clientId: string,
): Promise<TokenResponse> {
  if (!clientId || clientId !== OAUTH_POLICY.clientId) {
    throw new Error('OAuth client ID does not match the approved tuple');
  }
  const expectedAudience = OAUTH_POLICY.expectedAudience;
  if (!expectedAudience) throw new Error('OAuth expected audience is required');
  const { scopes, requiredScopes } = scheme.params;
  const deviceAuthorizationUrl = trustedOAuthEndpoint(
    scheme.params.deviceAuthorizationUrl,
    OAUTH_POLICY.deviceAuthorizationEndpoint,
    'device authorization endpoint',
  );
  const tokenUrl = trustedOAuthEndpoint(
    scheme.params.tokenUrl,
    OAUTH_POLICY.tokenEndpoint,
    'token endpoint',
  );

  // Step 1: Request a device code
  const scopeStr = approvedScope(scopes, requiredScopes);
  const requestedScopes = scopeStr.split(/\s+/).filter(Boolean);
  const deviceRes = await fetch(deviceAuthorizationUrl, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      ...(scopeStr ? { scope: scopeStr } : {}),
    }),
  });

  if (!deviceRes.ok) {
    throw new Error(
      `Device authorization failed: HTTP ${deviceRes.status} ${deviceRes.statusText}`,
    );
  }

  const deviceData = (await deviceRes.json()) as DeviceAuthResponse;
  if (
    typeof deviceData.device_code !== 'string' ||
    typeof deviceData.user_code !== 'string' ||
    typeof deviceData.verification_uri !== 'string' ||
    (deviceData.verification_uri_complete !== undefined &&
      typeof deviceData.verification_uri_complete !== 'string')
  ) {
    throw new Error('Device authorization response is incomplete');
  }
  let pollInterval = Number.isFinite(deviceData.interval) && deviceData.interval! > 0
    ? deviceData.interval! * 1000
    : 5_000;

  // A compromised endpoint can return a phishing URL. Validate before displaying it.
  const verificationUrl = trustedVerificationUrl(
    deviceData.verification_uri_complete ?? deviceData.verification_uri,
  );

  // Step 2: Display instructions to the user
  console.log('');
  console.log('  To authenticate, visit:');
  console.log(`  ${verificationUrl.toString()}`);
  if (!deviceData.verification_uri_complete) {
    console.log(`  and enter code: ${deviceData.user_code}`);
  }
  console.log('');
  process.stdout.write('  Waiting for authorization...');

  // Step 3: Poll the token endpoint
  const lifetime = Number.isFinite(deviceData.expires_in) && deviceData.expires_in! > 0
    ? deviceData.expires_in!
    : 300;
  const deadline = Date.now() + lifetime * 1000;

  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, pollInterval));

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceData.device_code,
        client_id: clientId,
      }),
    });

    const tokenData = (await tokenRes.json()) as TokenResponse | TokenErrorResponse;

    if ('access_token' in tokenData) {
      if (typeof tokenData.access_token !== 'string' || !tokenData.access_token) {
        throw new Error('Token response omitted access_token');
      }
      assertBearerTokenType(tokenData.token_type);
      assertGrantedScope(tokenData.scope, requestedScopes);
      await assertTokenPolicy(
        tokenData.access_token,
        expectedAudience,
        requestedScopes,
      );
      console.log(' Authorized!');
      return tokenData;
    }

    const errorData = tokenData as TokenErrorResponse;
    if (errorData.error === 'authorization_pending') {
      process.stdout.write('.');
      continue;
    }
    if (errorData.error === 'slow_down') {
      pollInterval += 5_000;
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

Configure singular exact device, token, and refresh endpoints plus verification
origins, client ID, audience, and allowed scopes for this approved card+agent
tuple. Do not combine identity endpoints from several agents into one allowlist.
`params.scopes` is the advertised catalogue; request only
`params.requiredScopes`, rejecting missing values or any value absent from the
catalogue/policy. Validate the resulting token's audience/resource before
attachment. Reject redirects so an approved endpoint cannot forward secrets
elsewhere. If local HTTP identity infrastructure is required, implement a
narrow development-only exception rather than weakening the production rule.

Use it from `resolveScheme`:

```typescript
if (scheme instanceof OAuth2DeviceCodeAuthScheme) {
  const tokens = await performDeviceCodeFlow(scheme, process.env.OAUTH_CLIENT_ID!);
  scheme.setCredential(tokens.access_token);
  return;
}
```

---

## Handling the Error Codes

The OAuth2 Device Authorization Grant spec ([RFC 8628 §3.5](https://datatracker.ietf.org/doc/html/rfc8628#section-3.5)) defines these terminal and non-terminal errors from the token endpoint:

| Error | Meaning | CLI behavior |
|-------|---------|--------------|
| `authorization_pending` | User hasn't approved yet. Keep polling. | Continue loop. |
| `slow_down` | Polling too fast. Increase all subsequent intervals by ≥5s. | Increase interval, continue. |
| `access_denied` | User rejected the request. | Fatal, throw. |
| `expired_token` | Device code passed its `expires_in`. | Fatal, throw. |
| (any other) | Protocol error. | Fatal, throw. |

The CLI catches `authorization_pending` and `slow_down` and treats **every other** error as fatal — including unknown ones. That matches the spec: only those two are non-terminal.

---

## Client Authentication on the Token Endpoint

RFC 8628 requires `client_id` in both the device authorization and token polling requests unless the client authenticates by another method. The reference accepts this host-configured ID explicitly. A confidential client may additionally authenticate with a secret using the method required by its authorization server:

```typescript
body: new URLSearchParams({
  grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
  device_code: deviceData.device_code,
  client_id: process.env.OAUTH_CLIENT_ID!,
  // client_secret: process.env.OAUTH_CLIENT_SECRET!,  // only for confidential clients
}),
```

The device-code flow is typically used with **public** clients (no secret), so `client_id` is usually enough. Never obtain the client ID or secret from the agent card.

---

## Storing and Refreshing the Token Set

`performDeviceCodeFlow` returns the full token set so callers do not discard `refresh_token` or expiry. Extend the slot-safe store from [token-persistence.md](./token-persistence.md):

```typescript
interface StoredCredential {
  slot: string;
  credential: string;
  refreshCredential?: string;
  expiresAt?: number;
}
```

The provider can retain newly issued token sets until `_save` serializes the selected group:

```typescript
private readonly tokenSets = new Map<string, TokenResponse>();

private async _resolveForSlot(
  groupIndex: number,
  schemeIndex: number,
  scheme: AuthScheme,
): Promise<void> {
  if (!(scheme instanceof OAuth2DeviceCodeAuthScheme)) {
    await resolveScheme(scheme);
    return;
  }
  const tokens = await performDeviceCodeFlow(
    scheme,
    process.env.OAUTH_CLIENT_ID!,
  );
  scheme.setCredential(tokens.access_token);
  this.tokenSets.set(credentialSlot(groupIndex, schemeIndex, scheme), tokens);
}

private _save(groupIndex: number, group: AuthScheme[]): void {
  const entries = group.map((scheme, schemeIndex): StoredCredential => {
    const slot = credentialSlot(groupIndex, schemeIndex, scheme);
    const access = extractCredential(slot, scheme);
    const tokens = this.tokenSets.get(slot);
    return {
      ...access,
      ...(tokens?.refresh_token
        ? { refreshCredential: tokens.refresh_token }
        : {}),
      ...(tokens?.expires_in
        ? { expiresAt: Date.now() + tokens.expires_in * 1000 }
        : {}),
    };
  });
  saveCredentials(this.policyKey, entries);
}

async refresh(schemes: AuthScheme[]): Promise<AuthScheme[]> {
  const groupIndex = this.selectedGroupIndex;
  if (groupIndex === undefined) {
    throw new Error('Cannot refresh before selecting an auth group');
  }
  const stored = loadCredentials(this.policyKey) ?? [];
  const clientId = process.env.OAUTH_CLIENT_ID!;

  for (const [schemeIndex, scheme] of schemes.entries()) {
    if (scheme instanceof OAuth2DeviceCodeAuthScheme) {
      const slot = credentialSlot(groupIndex, schemeIndex, scheme);
      const previous = stored.find(entry => entry.slot === slot);
      let tokens = previous?.refreshCredential
        ? await tryRefreshToken(
            scheme,
            previous.refreshCredential,
            clientId,
          )
        : undefined;
      if (!tokens) tokens = await performDeviceCodeFlow(scheme, clientId);
      if (!tokens.refresh_token && previous?.refreshCredential) {
        tokens.refresh_token = previous.refreshCredential;
      }
      scheme.setCredential(tokens.access_token);
      this.tokenSets.set(slot, tokens);
    } else {
      await resolveScheme(scheme);
    }
  }
  this._save(groupIndex, schemes);
  return schemes;
}

export async function tryRefreshToken(
  scheme: OAuth2DeviceCodeAuthScheme,
  refreshToken: string,
  clientId: string,
): Promise<TokenResponse | undefined> {
  const expectedAudience = OAUTH_POLICY.expectedAudience;
  if (!expectedAudience) throw new Error('OAuth expected audience is required');
  const scope = approvedScope(
    scheme.params.scopes,
    scheme.params.requiredScopes,
  );
  const requestedScopes = scope.split(/\s+/).filter(Boolean);
  const trustedTokenUrl = trustedOAuthEndpoint(
    scheme.params.refreshUrl ?? scheme.params.tokenUrl,
    OAUTH_POLICY.refreshEndpoint,
    'refresh endpoint',
  );
  const res = await fetch(trustedTokenUrl, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: clientId,
      ...(scope ? { scope } : {}),
    }),
  });
  if (!res.ok) return undefined;
  const data = (await res.json()) as TokenResponse | TokenErrorResponse;
  if (!('access_token' in data)) return undefined;
  if (typeof data.access_token !== 'string' || !data.access_token) return undefined;
  assertBearerTokenType(data.token_type);
  assertGrantedScope(data.scope, requestedScopes);
  await assertTokenPolicy(data.access_token, expectedAudience, requestedScopes);
  return data;
}
```

In `provide()`, replace the generic resolution loop for a newly selected group with the slot-aware method before saving:

```typescript
for (const [schemeIndex, scheme] of group.entries()) {
  await this._resolveForSlot(groupIndex, schemeIndex, scheme);
}
this._save(groupIndex, group);
```

For confidential clients, authenticate the refresh request using the authorization server's configured method. Apply the same exact endpoint, allowed-scope, issuer, audience/resource, and client-identity policy as the initial exchange.

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
