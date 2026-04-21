# Authentication

A2X ships adapters for the auth schemes A2A defines plus OpenID Connect and Mutual TLS. This guide walks each scheme, how to declare it on the server, and how the client sees it.

## Declaring auth on the server

Every scheme follows the same two-step pattern:

1. Register the scheme with `a2xAgent.addSecurityScheme(id, scheme)`. This publishes it on the AgentCard so clients know what to expect.
2. Add a `SecurityRequirement` with `a2xAgent.addSecurityRequirement({ id: [] })` to enforce it.

Multiple requirements act as **OR** (any satisfies); multiple schemes inside one requirement act as **AND** (all required).

```ts
a2xAgent
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

a2xAgent
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

a2xAgent.addSecurityScheme('bearer', new HttpBearerAuthorization({
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

a2xAgent.addSecurityScheme('oauthCode', new OAuth2AuthorizationCodeAuthorization({
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

a2xAgent.addSecurityScheme('oauthService', new OAuth2ClientCredentialsAuthorization({
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

a2xAgent.addSecurityScheme('deviceCode', new OAuth2DeviceCodeAuthorization({
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

a2xAgent.addSecurityScheme('oidc', new OpenIdConnectAuthorization({
  openIdConnectUrl: 'https://auth.example.com/.well-known/openid-configuration',
  validator: async (token) => { /* verify id_token or access_token */ },
}));
```

## Mutual TLS

Client-certificate-based auth.

```ts
import { MutualTlsAuthorization } from '@a2x/sdk';

a2xAgent.addSecurityScheme('mtls', new MutualTlsAuthorization({
  validator: async (context) => {
    const cert = context.clientCertificate;
    return cert && isTrusted(cert)
      ? { authenticated: true, principal: cert.subject.CN }
      : { authenticated: false };
  },
}));
```

Your HTTP layer must terminate TLS with client-cert verification enabled and pass the cert through on `RequestContext.clientCertificate`.

## Client side: handling auth

### Static headers

For API keys and bearer tokens, pass them as headers on the client:

```ts
const client = new A2XClient(url, {
  auth: { apiKey: 'your-secret-key' },
});
```

### OAuth flows

`AuthenticatedA2AClient` (exported from `@a2x/sdk/auth`) wraps `A2XClient` and adds token acquisition/refresh. For Device Code specifically:

```ts
import { DeviceFlowClient } from '@a2x/sdk/auth';

const flow = new DeviceFlowClient({
  deviceAuthorizationUrl: 'https://auth.example.com/device/code',
  tokenUrl: 'https://auth.example.com/token',
  clientId: 'your-client-id',
  scopes: ['api'],
});

const { userCode, verificationUri } = await flow.start();
console.log(`Go to ${verificationUri} and enter code: ${userCode}`);

const tokens = await flow.pollForTokens();
```

Use the returned `access_token` as the bearer on subsequent `A2XClient` calls.

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
