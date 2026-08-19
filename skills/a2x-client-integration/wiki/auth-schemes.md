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
| `'cookie'` | Append `<name>=<credential>` to the existing `Cookie` header. |

Distinct cookie schemes compose in one AND group. Alternatives that would overwrite the same header/query/cookie destination—or combine two schemes that both own `Authorization`—are omitted during normalization because they cannot be represented faithfully in one HTTP request.

Example masked prompt (CLI; see [host-cli.md](./host-cli.md) for `promptSecret`):

```typescript
if (scheme instanceof ApiKeyAuthScheme) {
  const key = await promptSecret(`Enter API key (${scheme.params.name})`);
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
const pass = await promptSecret('Password');
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
  //   requiredScopes?: readonly string[],
  // }
```

Credential format: access token (opaque or JWT — the scheme does not care).

Application: `headers['Authorization'] = 'Bearer <credential>'`

The scheme does **not** run the device-code flow for you. Treat every URL advertised by the card as untrusted: require a preconfigured HTTPS issuer/origin allowlist, reject redirects, and validate the returned verification URL before displaying it. You are responsible for:

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
  //   requiredScopes?: readonly string[],
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
  //   requiredScopes?: readonly string[],
  // }
```

Credential format: access token.

Application: `headers['Authorization'] = 'Bearer <credential>'`

Machine-to-machine flow — typically best for backend services:

```typescript
async function resolveClientCredentials(scheme: OAuth2ClientCredentialsAuthScheme) {
  const tokenUrl = trustedOAuthEndpoint(scheme.params.tokenUrl, 'token endpoint');
  const scope = approvedScope(
    scheme.params.scopes,
    scheme.params.requiredScopes,
  ); // selected requirement intersected with host policy
  const res = await fetch(tokenUrl, {
    method: 'POST',
    redirect: 'error',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.OAUTH_CLIENT_ID!,
      client_secret: process.env.OAUTH_CLIENT_SECRET!,
      ...(scope ? { scope } : {}),
    }),
  });
  if (!res.ok) throw new Error(`Token request failed: HTTP ${res.status}`);
  const data = await res.json() as {
    access_token?: string;
    token_type?: string;
    scope?: string;
  };
  if (
    typeof data.access_token !== 'string' || !data.access_token ||
    typeof data.token_type !== 'string' ||
    data.token_type.toLowerCase() !== 'bearer'
  ) {
    throw new Error('Token endpoint omitted a Bearer access token');
  }
  if (data.scope !== undefined && typeof data.scope !== 'string') {
    throw new Error('Token endpoint returned an invalid scope');
  }
  const requestedScopes = scope.split(/\s+/).filter(Boolean);
  assertGrantedScope(data.scope, requestedScopes);
  await assertTokenPolicy(
    data.access_token,
    process.env.OAUTH_EXPECTED_AUDIENCE!,
    requestedScopes,
  );
  scheme.setCredential(data.access_token);
}
```

`trustedOAuthEndpoint` should require an exact configured HTTPS endpoint.
`approvedScope` must request only `requiredScopes` and reject a value absent
from either the advertised `scopes` catalogue or host policy keyed by card URL,
resolved agent endpoint, issuer, client identity, and expected audience/resource.
`assertGrantedScope` and `assertTokenPolicy` enforce the exact returned scope and
cryptographically verified issuer/audience policy. See
[oauth2-device-code.md](./oauth2-device-code.md) for complete helpers.

---

## `OAuth2ImplicitAuthScheme`

```typescript
scheme.params  // {
  //   authorizationUrl: string,
  //   scopes: Record<string, string>,
  //   refreshUrl?: string,
  //   requiredScopes?: readonly string[],
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
  //   requiredScopes?: readonly string[],
  // }
```

Deprecated by OAuth2 spec. If supported, POST `grant_type=password` with username/password to `tokenUrl`. Same treatment as client credentials.

---

## `OpenIdConnectAuthScheme`

```typescript
scheme.params  // {
  //   openIdConnectUrl: string,
  //   requiredScopes?: readonly string[],
  // }
```

Credential format: an audience-bound access token for the A2A resource. Use an ID token only when that resource explicitly defines and safely validates it as its bearer credential.

Application: `headers['Authorization'] = 'Bearer <credential>'`

The `openIdConnectUrl` points to the OIDC discovery document (`.well-known/openid-configuration`). The selected requirement values are exposed as `requiredScopes`. You are responsible for running whichever OIDC flow is appropriate, validating the exact issuer/audience/resource/scopes, and providing the resulting access token.

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
