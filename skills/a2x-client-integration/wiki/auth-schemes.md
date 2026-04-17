# Auth Schemes

Every `AuthScheme` subclass the SDK may hand to `AuthProvider.provide()`, with the credential format each expects and how each applies to an outgoing request.

All schemes share the same base:

```typescript
abstract class AuthScheme {
  protected credential?: string;

  setCredential(value: string): this;    // fluent
  abstract applyToRequest(ctx: AuthRequestContext): void;
}

interface AuthRequestContext {
  headers: Record<string, string>;
  url: URL;
}
```

Import from `@a2x/sdk/client`:

```typescript
import {
  AuthScheme,
  ApiKeyAuthScheme,
  HttpBearerAuthScheme,
  HttpBasicAuthScheme,
  OAuth2DeviceCodeAuthScheme,
  OAuth2AuthorizationCodeAuthScheme,
  OAuth2ClientCredentialsAuthScheme,
  OAuth2ImplicitAuthScheme,
  OAuth2PasswordAuthScheme,
  OpenIdConnectAuthScheme,
} from '@a2x/sdk/client';
```

---

## `ApiKeyAuthScheme`

```typescript
scheme.params  // { name: string, location: 'header' | 'query' | 'cookie' }
```

Credential format: raw API key string.

Application:

| `location` | Effect |
|------------|--------|
| `'header'` | `headers[scheme.params.name] = credential` |
| `'query'` | `url.searchParams.set(scheme.params.name, credential)` |
| `'cookie'` | `headers['Cookie'] = '<name>=<credential>'` |

Note: `'cookie'` overwrites any existing `Cookie` header. If multiple cookie-based schemes are active (rare), merge before calling `applyToRequest` or use a custom fetch.

Example prompt (CLI):

```typescript
if (scheme instanceof ApiKeyAuthScheme) {
  const key = await prompt(`Enter API key (${scheme.params.name}): `);
  scheme.setCredential(key);
}
```

---

## `HttpBearerAuthScheme`

```typescript
scheme.params  // { bearerFormat?: string }  e.g. 'JWT'
```

Credential format: raw token (no `Bearer ` prefix — the scheme adds it).

Application: `headers['Authorization'] = 'Bearer <credential>'`

`bearerFormat` is informational only (the SDK does not validate it). Use it to decide the UX: `'JWT'` suggests a copy-paste of a JWT, undefined might be an opaque token.

---

## `HttpBasicAuthScheme`

```typescript
scheme.params  // {}
```

Credential format: **already base64-encoded** `username:password`. The scheme does **not** encode for you.

Application: `headers['Authorization'] = 'Basic <credential>'`

If you are prompting the user, encode before `setCredential`:

```typescript
const user = await prompt('Username: ');
const pass = await prompt('Password: ');
const encoded = Buffer.from(`${user}:${pass}`).toString('base64');
scheme.setCredential(encoded);
```

---

## `OAuth2DeviceCodeAuthScheme`

```typescript
scheme.params  // {
  //   deviceAuthorizationUrl: string,
  //   tokenUrl: string,
  //   scopes: Record<string, string>,
  //   refreshUrl?: string,
  // }
```

Credential format: access token (opaque or JWT — the scheme does not care).

Application: `headers['Authorization'] = 'Bearer <credential>'`

The scheme does **not** run the device-code flow for you. You are responsible for:

1. POST to `deviceAuthorizationUrl` (form-encoded) with optional `scope`.
2. Display the returned `verification_uri` / `user_code` to the user.
3. Poll `tokenUrl` with `grant_type=urn:ietf:params:oauth:grant-type:device_code` and `device_code=...` at `interval` seconds until you get an `access_token` or exceed `expires_in`.
4. Call `scheme.setCredential(access_token)`.

See [oauth2-device-code.md](./oauth2-device-code.md) for a reusable, tested implementation copied from the CLI reference.

---

## `OAuth2AuthorizationCodeAuthScheme`

```typescript
scheme.params  // {
  //   authorizationUrl: string,
  //   tokenUrl: string,
  //   scopes: Record<string, string>,
  //   refreshUrl?: string,
  //   pkceRequired?: boolean,
  // }
```

Credential format: access token.

Application: `headers['Authorization'] = 'Bearer <credential>'`

Running this flow requires:

- A browser redirect to `authorizationUrl?response_type=code&client_id=...&redirect_uri=...&scope=...&state=...` (plus PKCE `code_challenge` if `pkceRequired`).
- A registered redirect handler that captures the `?code=...`.
- A token exchange POST to `tokenUrl` with the code + client secret (or PKCE `code_verifier`).

Not feasible from a pure CLI — typically only viable in browsers or in CLIs that can open a local loopback HTTP server as the redirect target. The CLI reference implementation punts: it prompts for an already-acquired access token.

---

## `OAuth2ClientCredentialsAuthScheme`

```typescript
scheme.params  // {
  //   tokenUrl: string,
  //   scopes: Record<string, string>,
  //   refreshUrl?: string,
  // }
```

Credential format: access token.

Application: `headers['Authorization'] = 'Bearer <credential>'`

Machine-to-machine flow — typically best for backend services:

```typescript
async function resolveClientCredentials(scheme: OAuth2ClientCredentialsAuthScheme) {
  const res = await fetch(scheme.params.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.OAUTH_CLIENT_ID!,
      client_secret: process.env.OAUTH_CLIENT_SECRET!,
      scope: Object.keys(scheme.params.scopes).join(' '),
    }),
  });
  const { access_token } = await res.json() as { access_token: string };
  scheme.setCredential(access_token);
}
```

---

## `OAuth2ImplicitAuthScheme`

```typescript
scheme.params  // {
  //   authorizationUrl: string,
  //   scopes: Record<string, string>,
  //   refreshUrl?: string,
  // }
```

Deprecated OAuth2 flow — token arrives in a URL fragment after browser redirect. If the agent only offers this flow, prompt for an already-acquired token.

---

## `OAuth2PasswordAuthScheme`

```typescript
scheme.params  // {
  //   tokenUrl: string,
  //   scopes: Record<string, string>,
  //   refreshUrl?: string,
  // }
```

Deprecated by OAuth2 spec. If supported, POST `grant_type=password` with username/password to `tokenUrl`. Same treatment as client credentials.

---

## `OpenIdConnectAuthScheme`

```typescript
scheme.params  // { openIdConnectUrl: string }
```

Credential format: ID token.

Application: `headers['Authorization'] = 'Bearer <credential>'`

The `openIdConnectUrl` points to the OIDC discovery document (`.well-known/openid-configuration`). You are responsible for running whichever OIDC flow is appropriate and providing the resulting token.

---

## Selection Heuristics

When `provide()` receives multiple OR groups, you need a rule to pick one. Common heuristics:

```typescript
function pickGroup(groups: AuthScheme[][]): AuthScheme[] {
  // 1. Prefer simpler schemes first if we can satisfy them non-interactively
  const ordered = [...groups].sort(complexityAscending);
  for (const group of ordered) {
    if (canSatisfyFromEnv(group)) return group;
  }
  // 2. Fall back to interactive / first group
  return groups[0];
}

function complexityAscending(a: AuthScheme[], b: AuthScheme[]): number {
  const rank = (schemes: AuthScheme[]) =>
    Math.max(...schemes.map(schemeRank));
  return rank(a) - rank(b);
}

function schemeRank(s: AuthScheme): number {
  if (s instanceof ApiKeyAuthScheme) return 0;
  if (s instanceof HttpBearerAuthScheme) return 1;
  if (s instanceof HttpBasicAuthScheme) return 1;
  if (s instanceof OAuth2ClientCredentialsAuthScheme) return 2;
  if (s instanceof OAuth2DeviceCodeAuthScheme) return 3;
  return 10;
}
```

The CLI uses a user-prompt instead of heuristics — when >1 groups exist, it asks the user which method to use. That is the right call for interactive tools; for automated clients, prefer heuristics so the operator does not have to configure "pick this branch" separately.
