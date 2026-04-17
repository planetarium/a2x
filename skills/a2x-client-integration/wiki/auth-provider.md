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
   * (Optional) Called once by the SDK after a non-streaming request
   * returns HTTP 401. Receives the same scheme instances previously
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

The SDK constructs `AuthScheme` instances once per client from the agent card. The same instances are:

- passed to `provide()`
- returned by `provide()`
- cached inside the client
- re-applied on every outgoing request
- passed to `refresh()` on 401

**Do not construct new `AuthScheme` instances inside `provide()`.** Mutate the ones the SDK hands you (via `setCredential`) and return them.

This invariant is what lets you keep a `requirement-group → credentials` mapping keyed by `scheme.constructor.name` — the CLI reference implementation relies on it.

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
        ├── [first call only] resolveAgentCard → card
        │
        ├── [first call only] if card has securityRequirements:
        │       requirements = normalizeRequirements(card)
        │       schemes = await authProvider.provide(requirements)
        │       cache schemes
        │
        ├── build request, applyToRequest(ctx) for each cached scheme
        │
        ├── fetch → response
        │
        ├── if response.status === 401 and refresh exists:
        │       schemes = await authProvider.refresh(cachedSchemes)
        │       cache schemes (may be same instances)
        │       retry request exactly once
        │
        └── return parsed result
```

Key properties:

- `provide()` is called **at most once per client instance** under normal operation.
- `refresh()` is called **at most once per failing request**. If the retry also fails, the error is thrown without another refresh attempt.
- For `sendMessageStream()`, only `provide()` is invoked — there is no refresh path for streaming requests. A 401 during streaming surfaces as an `InternalError` (`HTTP 401: …`).

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

class EnvAuthProvider implements AuthProvider {
  async provide(requirements: AuthScheme[][]): Promise<AuthScheme[]> {
    for (const group of requirements) {
      if (this.tryFill(group)) return group;
    }
    throw new Error('No credentials configured for the required schemes');
  }

  private tryFill(group: AuthScheme[]): boolean {
    const filled: AuthScheme[] = [];
    for (const scheme of group) {
      const value = this.lookup(scheme);
      if (!value) return false;
      scheme.setCredential(value);
      filled.push(scheme);
    }
    return filled.length === group.length;
  }

  private lookup(scheme: AuthScheme): string | undefined {
    if (scheme instanceof ApiKeyAuthScheme) return process.env.AGENT_API_KEY;
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
