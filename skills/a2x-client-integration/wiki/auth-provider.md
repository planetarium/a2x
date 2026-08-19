# Auth Provider Contract

The `AuthProvider` interface is the one integration point between `A2XClient` and your host application for credential acquisition. Everything else in the auth stack — parsing the agent card, building scheme classes, handling OAuth2 flow expansion — lives inside the SDK.

---

## The Interface

```typescript
export interface AuthProvider {
  /**
   * Resolve which security requirement group to use and fill in credentials.
   *
   * @param requirements  OR-of-ANDs structure from the agent card:
   *                      outer array  → OR groups (satisfy ANY)
   *                      inner array  → AND schemes within a group (satisfy ALL)
   * @returns             The resolved group — same AuthScheme instances, each
   *                      with a credential attached via setCredential().
   * @throws              If no group can be satisfied.
   */
  provide(requirements: AuthScheme[][]): Promise<AuthScheme[]>;

  /**
   * (Optional) Called once by the SDK when a task-creating response
   * reports `auth-required`. Receives the same scheme instances previously
   * returned by provide(). Implementations typically re-prompt / re-fetch
   * and call setCredential() with a new value.
   */
  refresh?(schemes: AuthScheme[]): Promise<AuthScheme[]>;
}
```

Import from `@a2x/sdk/client`:

```typescript
import type { AuthProvider } from '@a2x/sdk/client';
```

---

## OR-of-ANDs Semantics

The `requirements` parameter mirrors the OpenAPI-style security semantics from the agent card:

| Card construct | SDK representation |
|----------------|--------------------|
| `securityRequirements: [{ apiKey: [] }]` | `[ [ApiKeyAuthScheme] ]` |
| `securityRequirements: [{ apiKey: [] }, { bearer: [] }]` | `[ [ApiKeyAuthScheme], [HttpBearerAuthScheme] ]` (OR — pick one) |
| `securityRequirements: [{ apiKey: [], bearer: [] }]` | `[ [ApiKeyAuthScheme, HttpBearerAuthScheme] ]` (AND — both) |
| `securityRequirements: [{ oauth2: [...] }]` with 3 OAuth2 flows | `[ [DeviceCodeScheme], [AuthorizationCodeScheme], [ClientCredentialsScheme] ]` (OR per flow) |

Your `provide()` must:

1. Pick exactly one group from the outer array (either by preference, user choice, or what credentials it has available).
2. Call `setCredential()` on **every** scheme in that group.
3. Return that same group.

Returning a group with an unset credential will cause `applyToRequest()` to emit `undefined` and the server request will fail.

---

## Scheme Instance Identity

After initialization completes, the SDK retains one active `AuthScheme` set derived from the agent card. Those cached instances are:

- passed to `provide()`
- returned by `provide()`
- cached inside the client
- re-applied on every outgoing request
- passed to `refresh()` after an `auth-required` task or an `auth-required` first stream event

Concurrent cold-start resolution can construct transient competing sets before one is cached; do not use object identity as a persistence key or assume construction happens exactly once.

**Do not construct new `AuthScheme` instances inside `provide()`.** Mutate the ones the SDK hands you (via `setCredential`) and return them.

Instance reuse does not make `scheme.constructor.name` a unique persistence key. A requirement group can contain two instances of the same subclass, such as API keys in different headers. Persist a slot identity derived from the requirement-group position, scheme position, class, and public parameters. The CLI reference implementation currently uses only the class name and therefore assumes at most one instance of each subclass per group.

---

## Lifecycle

```
new A2XClient(...)
        │
        │   [no I/O yet]
        │
        ▼
await client.sendMessage(...)
        │
        ├── [first completed initialization] resolveAgentCard → card
        │
        ├── [first completed initialization] if card has securityRequirements:
        │       requirements = normalizeRequirements(card)
        │       schemes = await authProvider.provide(requirements)
        │       cache schemes
        │
        ├── build request, applyToRequest(ctx) for each cached scheme
        │
        ├── fetch → task or stream
        │
        ├── if the task, or exactly the first stream event, is an
        │   auth-required status and refresh + resolved schemes exist:
        │       schemes = await authProvider.refresh(cachedSchemes)
        │       cache schemes (may be same instances)
        │       retry request exactly once
        │
        └── return parsed result
```

Key properties:

- A completed `provide()` result is reused, but concurrent cold-start calls can invoke `provide()` more than once. Make it concurrency-safe and deduplicate interactive or expensive work in the provider.
- `refresh()` is called **at most once per `auth-required` task-creating request**, and only when it exists and schemes were previously resolved. If refresh is unavailable or the retry is also `auth-required`, the task or event is surfaced.
- `sendMessageStream()` buffers exactly its first event. It can refresh only when that event is an `auth-required` status event; a later status event does not trigger refresh.
- An HTTP 401 is not refreshed automatically; both blocking and streaming calls surface it as `InternalError('HTTP 401: Unauthorized')`.

---

## Minimal Implementations

### Pass-through from environment (backend)

```typescript
import type { AuthProvider } from '@a2x/sdk/client';
import {
  AuthScheme,
  ApiKeyAuthScheme,
  HttpBearerAuthScheme,
} from '@a2x/sdk/client';

const API_KEY_ENV_BY_SLOT: Record<string, string> = {
  'header:x-api-key': 'AGENT_API_KEY',
  'header:x-tenant-key': 'AGENT_TENANT_API_KEY',
};

class EnvAuthProvider implements AuthProvider {
  async provide(requirements: AuthScheme[][]): Promise<AuthScheme[]> {
    for (const group of requirements) {
      const credentials = group.map(scheme => this.lookup(scheme));
      if (credentials.every(
        (value): value is string => typeof value === 'string' && value.length > 0,
      )) {
        group.forEach((scheme, index) => scheme.setCredential(credentials[index]!));
        return group;
      }
    }
    throw new Error('No credentials configured for the required schemes');
  }

  private lookup(scheme: AuthScheme): string | undefined {
    if (scheme instanceof ApiKeyAuthScheme) {
      const name = scheme.params.location === 'header'
        ? scheme.params.name.toLowerCase()
        : scheme.params.name;
      const envName = API_KEY_ENV_BY_SLOT[`${scheme.params.location}:${name}`];
      return envName ? process.env[envName] : undefined;
    }
    if (scheme instanceof HttpBearerAuthScheme) return process.env.AGENT_BEARER_TOKEN;
    return undefined;
  }
}
```

### Static single-scheme (test / fixture)

```typescript
class StaticBearerProvider implements AuthProvider {
  constructor(private readonly token: string) {}

  async provide(requirements: AuthScheme[][]): Promise<AuthScheme[]> {
    for (const group of requirements) {
      if (group.length === 1 && group[0] instanceof HttpBearerAuthScheme) {
        group[0].setCredential(this.token);
        return group;
      }
    }
    throw new Error('Agent does not accept a plain Bearer token');
  }
}
```

### Interactive (CLI) — see [host-cli.md](./host-cli.md)

Full reference in [auth-fallback-chain.md](./auth-fallback-chain.md).

---

## Testing Your Provider

The SDK exports `normalizeRequirements` so you can unit-test the provider without spinning up a real agent:

```typescript
import { normalizeRequirements, ApiKeyAuthScheme } from '@a2x/sdk/client';

const requirements = normalizeRequirements(
  [{ apiKey: [] }],
  {
    apiKey: { type: 'apiKey', name: 'x-api-key', in: 'header' },
  },
);

// requirements === [ [ ApiKeyAuthScheme { name: 'x-api-key', location: 'header' } ] ]

const resolved = await new EnvAuthProvider().provide(requirements);
expect(resolved).toHaveLength(1);
expect(resolved[0]).toBeInstanceOf(ApiKeyAuthScheme);
```

You can also feed `normalizeRequirements` the exact `security` / `securityRequirements` array from a captured agent card and assert the provider's choice.
