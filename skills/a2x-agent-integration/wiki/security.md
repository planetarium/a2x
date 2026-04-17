# Security & Authentication

`@a2x/sdk` includes built-in security scheme classes that map to OpenAPI 3.x security. Authentication is evaluated automatically by `DefaultRequestHandler` when a `RequestContext` is provided.

---

## API Key Authentication

```typescript
import { ApiKeyAuthorization } from '@a2x/sdk';

const apiKeyScheme = new ApiKeyAuthorization({
  in: 'header',           // 'header' | 'query' | 'cookie'
  name: 'x-api-key',     // Header/query/cookie name
  description: 'API key for agent access',
  // Option 1: Static key list
  keys: ['key1', 'key2', 'key3'],
  // Option 2: Custom validator (overrides keys)
  // validator: async (key) => {
  //   const valid = await db.checkApiKey(key);
  //   return { authenticated: valid, principal: { sub: 'user-id' } };
  // },
});
```

---

## HTTP Bearer Token

```typescript
import { HttpBearerAuthorization } from '@a2x/sdk';

const bearerScheme = new HttpBearerAuthorization({
  description: 'Bearer token authentication',
  tokenValidator: async (token) => {
    // Validate JWT or opaque token
    const decoded = await verifyJwt(token);
    if (!decoded) return { authenticated: false, error: 'Invalid token' };
    return {
      authenticated: true,
      principal: { sub: decoded.sub },
      scopes: decoded.scopes,
    };
  },
});
```

---

## OAuth2 Device Code Flow

For CLI / headless clients (v1.0 protocol only; v0.3 will log a warning):

```typescript
import { OAuth2DeviceCodeAuthorization } from '@a2x/sdk';

const deviceCodeScheme = new OAuth2DeviceCodeAuthorization({
  deviceAuthorizationUrl: `${process.env.BASE_URL}/device/authorize`,
  tokenUrl: `${process.env.BASE_URL}/oauth/token`,
  scopes: { 'agent:invoke': 'Invoke the agent' },
  description: 'OAuth2 Device Code flow for CLI clients',
  tokenValidator: async (token, requiredScopes) => {
    // Validate the access token
    if (token !== expectedToken) {
      return { authenticated: false, error: 'Invalid access token' };
    }
    return {
      authenticated: true,
      principal: { sub: 'device-user' },
      scopes: ['agent:invoke'],
    };
  },
});
```

---

## Other Schemes

```typescript
import {
  HttpBasicAuthorization,
  OAuth2AuthorizationCodeAuthorization,
  OAuth2ClientCredentialsAuthorization,
  OAuth2PasswordAuthorization,
  OAuth2ImplicitAuthorization,
  OpenIdConnectAuthorization,
  MutualTlsAuthorization,
} from '@a2x/sdk';
```

---

## Registering Schemes on A2XAgent

```typescript
a2xAgent
  .addSecurityScheme('apiKey', apiKeyScheme)
  .addSecurityScheme('bearer', bearerScheme)
  .addSecurityScheme('deviceCode', deviceCodeScheme);
```

---

## Security Requirements (OR / AND logic)

Security requirements define which schemes must be satisfied. Multiple requirements use **OR** logic (any one satisfies). Multiple schemes within a single requirement use **AND** logic (all must pass).

### OR logic — either scheme satisfies:

```typescript
// User can authenticate with EITHER api key OR bearer token
a2xAgent
  .addSecurityRequirement({ apiKey: [] })
  .addSecurityRequirement({ bearer: ['agent:invoke'] });
```

### AND logic — both schemes must pass:

```typescript
// User must provide BOTH api key AND bearer token
a2xAgent
  .addSecurityRequirement({ apiKey: [], bearer: ['agent:invoke'] });
```

### Scopes

The array values are required scopes:
- `{ apiKey: [] }` — No scope required
- `{ bearer: ['agent:invoke'] }` — Requires `agent:invoke` scope

---

## Passing RequestContext

For authentication to work, you must pass a `RequestContext` to `handler.handle()`:

```typescript
import type { RequestContext } from '@a2x/sdk';

// Express
const context: RequestContext = {
  headers: req.headers as Record<string, string | string[] | undefined>,
  query: req.query as Record<string, string | string[] | undefined>,
};

// Next.js App Router
const context: RequestContext = {
  headers: Object.fromEntries(request.headers.entries()),
  query: Object.fromEntries(new URL(request.url).searchParams.entries()),
};

const result = await handler.handle(body, context);
```

If no `context` is provided, authentication is skipped.

---

## AuthResult

All validators return an `AuthResult`:

```typescript
interface AuthResult {
  authenticated: boolean;
  error?: string;          // Error message if not authenticated
  principal?: {            // User identity info
    sub?: string;
    [key: string]: unknown;
  };
  scopes?: string[];       // Granted scopes
}
```

---

## No-Auth Mode

If no security schemes are added, the agent runs without authentication (open access). This is fine for development but not recommended for production.
