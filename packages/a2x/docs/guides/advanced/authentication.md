# Authentication

A2X ships adapters for the auth schemes A2A defines plus OpenID Connect and Mutual TLS. This guide walks each scheme, how to declare it on the server, and how the client sees it.

## Declaring auth on the server

Every scheme follows the same two-step pattern:

1. Register the scheme with `a2xServer.addSecurityScheme(id, scheme)`. This publishes it on the AgentCard so clients know what to expect.
2. Add a `SecurityRequirement` with `a2xServer.addSecurityRequirement({ id: [] })` to enforce it.

Multiple requirements act as **OR** (any satisfies); multiple schemes inside one requirement act as **AND** (all required).

```ts
a2xServer
  .addSecurityScheme('apiKey', apiKeyScheme)
  .addSecurityScheme('bearer', bearerScheme)
  // OR: either apiKey OR bearer is enough
  .addSecurityRequirement({ apiKey: [] })
  .addSecurityRequirement({ bearer: [] });
```

## API Key

Simplest scheme — a static secret in a header, query, or cookie.

```ts
import { ApiKeyAuthorization } from '@a2x/sdk';

a2xServer
  .addSecurityScheme('apiKey', new ApiKeyAuthorization({
    in: 'header',
    name: 'x-api-key',
    keys: [process.env.API_KEY_A!, process.env.API_KEY_B!],
  }))
  .addSecurityRequirement({ apiKey: [] });
```

`keys` is the list of accepted values. Rotate by appending the new key, deploying, then removing the old.

## HTTP Bearer

Opaque tokens validated by your own logic — useful when you issue tokens from your own auth service.

```ts
import { HttpBearerAuthorization } from '@a2x/sdk';

a2xServer.addSecurityScheme('bearer', new HttpBearerAuthorization({
  validator: async (token) => {
    const session = await lookupSession(token);
    return session
      ? { authenticated: true, principal: session.userId }
      : { authenticated: false };
  },
}));
```

The validator returns `{ authenticated, principal? }`. `principal` is whatever identity representation is useful to your downstream code — it's available on `RequestContext`.

## OAuth 2.0

Three standard flows are supported out of the box.

### Authorization Code

```ts
import { OAuth2AuthorizationCodeAuthorization } from '@a2x/sdk';

a2xServer.addSecurityScheme('oauthCode', new OAuth2AuthorizationCodeAuthorization({
  authorizationUrl: 'https://auth.example.com/authorize',
  tokenUrl: 'https://auth.example.com/token',
  scopes: { read: 'Read access', write: 'Write access' },
  validator: async (token) => { /* verify against your provider */ },
}));
```

Use this for user-driven flows where the client can open a browser.

### Client Credentials

```ts
import { OAuth2ClientCredentialsAuthorization } from '@a2x/sdk';

a2xServer.addSecurityScheme('oauthService', new OAuth2ClientCredentialsAuthorization({
  tokenUrl: 'https://auth.example.com/token',
  scopes: { api: 'API access' },
  validator: async (token) => { /* verify */ },
}));
```

For service-to-service calls where no human is present.

### Device Code

For headless devices / CLIs without a browser.

```ts
import { OAuth2DeviceCodeAuthorization } from '@a2x/sdk';

a2xServer.addSecurityScheme('deviceCode', new OAuth2DeviceCodeAuthorization({
  deviceAuthorizationUrl: 'https://auth.example.com/device/code',
  tokenUrl: 'https://auth.example.com/token',
  scopes: { api: 'API access' },
  validator: async (token) => { /* verify */ },
}));
```

The CLI consumes this scheme via `DeviceFlowClient` — see [Protocol Extensions](./extensions.md) for how A2X surfaces Device Code on v0.3 cards.

## OpenID Connect

Standard OIDC discovery endpoint.

```ts
import { OpenIdConnectAuthorization } from '@a2x/sdk';

a2xServer.addSecurityScheme('oidc', new OpenIdConnectAuthorization({
  openIdConnectUrl: 'https://auth.example.com/.well-known/openid-configuration',
  validator: async (token) => { /* verify id_token or access_token */ },
}));
```

## Mutual TLS

Client-certificate-based auth.

```ts
import { MutualTlsAuthorization } from '@a2x/sdk';

a2xServer.addSecurityScheme('mtls', new MutualTlsAuthorization({
  validator: async (context) => {
    const cert = context.clientCertificate;
    return cert && isTrusted(cert)
      ? { authenticated: true, principal: cert.subject.CN }
      : { authenticated: false };
  },
}));
```

Your HTTP layer must terminate TLS with client-cert verification enabled and pass the cert through on `RequestContext.clientCertificate`.

## How auth failures are surfaced

A2A models authentication failure as a Task lifecycle state, not a transport-level error:

- **v0.3** — `TaskState.auth-required` (`specification/a2a-v0.3.0.json:2450`).
- **v1.0** — `TASK_STATE_AUTH_REQUIRED` (`specification/a2a-v1.0.0.proto:206-207`). Per the v1.0 `SendMessage` semantics, servers MUST wait for `AUTH_REQUIRED` (an interrupted state) before returning under `return_immediately=false`.

The SDK follows this directly:

| Method | Response on auth failure |
|---|---|
| `message/send` | `result` is a Task with `status.state === 'auth-required'`. HTTP `200`. |
| `message/stream` | First (and only) SSE event is a `TaskStatusUpdateEvent` carrying `auth-required`, then the stream closes. HTTP `200`. |
| `tasks/get`, `tasks/cancel`, `tasks/pushNotificationConfig/*`, `agent/getAuthenticatedExtendedCard` | These methods don't return a Task, so they fall back to JSON-RPC `-32600 InvalidRequest`. HTTP `200`. |

`A2XClient` reacts to `auth-required` automatically:

```ts
const client = new A2XClient(url, { authProvider });

// If the server returns auth-required and AuthProvider implements
// refresh(), the client refreshes credentials and retries once before
// returning. If refresh is not configured, the auth-required Task is
// returned to the caller as-is.
const task = await client.sendMessage({ message });
```

The streaming counterpart buffers the first event: when it observes `auth-required` and `AuthProvider.refresh()` is available, it refreshes, opens a new stream, and yields that stream's events to the caller.

## Client side: handling auth

### Credential providers

Use an `AuthProvider` for credentials owned by a declared security scheme. It receives OR-of-AND requirement groups and must return one complete group after setting every credential:

```ts
import {
  A2XClient,
  ApiKeyAuthScheme,
  type AuthProvider,
  type AuthScheme,
} from '@a2x/sdk/client';

const authProvider: AuthProvider = {
  async provide(requirements: AuthScheme[][]) {
    const group = requirements.find(group =>
      group.length === 1 && group[0] instanceof ApiKeyAuthScheme
    );
    if (!group) throw new Error('No supported authentication alternative');
    group[0]!.setCredential(process.env.AGENT_API_KEY!);
    return group;
  },
};

const client = new A2XClient(url, { authProvider });
```

### OAuth flows

OAuth scheme classes expose two distinct scope fields:

- `params.scopes` is the flow's advertised scope-description map.
- `params.requiredScopes` is an immutable snapshot of the exact scope list from the selected security requirement.

Providers should reject missing or unknown `requiredScopes`, intersect that list with host policy, and request only those scopes. Do not request every key in `params.scopes`, and do not trust OAuth endpoints or scopes merely because an AgentCard advertised them.

`OpenIdConnectAuthScheme.params.requiredScopes` carries the same selected requirement values; validate them against trusted OIDC discovery, issuer, client, audience/resource, and scope policy before acquiring an access token.

The client expands OAuth flows into requirement alternatives but does not run an OAuth grant. Acquire a token in your `AuthProvider`, then set it on the supplied scheme:

```ts
import {
  OAuth2DeviceCodeAuthScheme,
  type AuthProvider,
} from '@a2x/sdk/client';

const authProvider: AuthProvider = {
  async provide(requirements) {
    const group = requirements.find(group =>
      group.length === 1 && group[0] instanceof OAuth2DeviceCodeAuthScheme
    );
    if (!group) throw new Error('Device code is not an available alternative');
    const scheme = group[0] as OAuth2DeviceCodeAuthScheme;
    const token = await runHostApprovedDeviceFlow({
      deviceAuthorizationUrl: scheme.params.deviceAuthorizationUrl,
      tokenUrl: scheme.params.tokenUrl,
      advertisedScopes: scheme.params.scopes,
      requiredScopes: scheme.params.requiredScopes,
    });
    scheme.setCredential(token.accessToken);
    return group;
  },
};
```

`runHostApprovedDeviceFlow` must reject required scopes absent from
`advertisedScopes` or host policy, validate the issuer/audience binding, and
accept only a case-insensitive `Bearer` token type before returning the access
token.

An explicitly empty security requirement (`{}`) is an anonymous alternative, so the client skips the provider. A non-empty alternative is omitted as a whole if any named scheme is absent, unsupported, or would overwrite another scheme's HTTP credential destination. Distinct cookie API keys compose. Expansion is capped at 256 alternatives to reject malicious combinatorial cards; when no supported non-empty alternative remains, a configured provider fails before the request is sent.

On a v1.0 AgentCard, each security requirement value uses the canonical protobuf JSON wrapper `{ list: string[] }`. The client also accepts the legacy a2x `{ values: string[] }` spelling when reading older cards, but newly generated cards always emit `list`.

## Exposing an authenticated extended AgentCard

Declaring security also unlocks `agent/getAuthenticatedExtendedCard` — a way to return a richer card (extra skills, private documentation URLs, per-principal metadata) only to callers that pass the security check. See [Authenticated Extended AgentCard](./extended-agent-card.md).

## Inspecting what an agent requires

Clients can introspect expected auth before calling:

```ts
const resolved = await client.resolveAgentCard();
console.log(resolved.card.securitySchemes);
console.log(resolved.card.securityRequirements);
```

This lets UI clients surface the right login flow to users dynamically.
