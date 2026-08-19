# Authentication Fallback Chain

This is the **reference pattern** for an interactive `AuthProvider`, based on `packages/cli/src/cli-auth-provider.ts` and hardened with collision-safe credential slots and masked secret input. Use it as the blueprint for any interactive client (CLI, TUI, dev tools) that must survive restarts and token expiry.

---

## The Three-Step Chain

```
provide(requirements)
  │
  │   ── Step 1: Stored credentials ────────────────────────────────────────
  │     loadCredentials(policyKey) → Array<{ slot, credential }>
  │     for each group and groupIndex in requirements:
  │       if all schemes have a stored match by unique slot key:
  │         scheme.setCredential(match.credential) for each
  │         return group
  │     // otherwise fall through
  │
  │   ── Step 2: Interactive resolution ──────────────────────────────────
  │     if requirements.length === 1:
  │       group = requirements[0]
  │     else:
  │       print each group's schemes as a numbered menu
  │       group = requirements[user-selected-index]
  │
  │     for each scheme in group:
  │       resolveScheme(scheme)   ← prompts / device-code / etc.
  │
  │     save credentials with group index + scheme index + class + params
  │     return group

refresh(schemes)   ← SDK calls after an auth-required task/event
  │
  │   ── Step 3: Invalidate and re-prompt ──────────────────────────────
  │     clearCredentials(policyKey)
  │
  │     for each scheme in schemes:
  │       resolveScheme(scheme)   ← same interactive UI as Step 2
  │
  │     save credentials using the selected group's slot keys
  │     return schemes
```

---

## Why Three Steps

Each step addresses a distinct failure mode:

| Step | Failure it covers |
|------|-------------------|
| 1. Stored | **Second-run friction.** Without persistence, the user re-authenticates on every CLI invocation. |
| 2. Interactive | **First-run bootstrap.** Stored credentials don't exist yet, or the user switched to a different agent. |
| 3. Refresh | **Credential expiry.** Stored token worked last time, but the agent now returns an `auth-required` task or an `auth-required` first stream event — stored credentials are stale. |

Skipping Step 1 is fine for short-lived workers that always re-prompt anyway (none, for a backend service). Skipping Step 3 leaves you vulnerable to stale tokens — any OAuth2-backed agent benefits from it.

---

## Key Implementation Details

### Use a unique credential-slot key

Do not store credentials only by `scheme.constructor.name`. A valid AND group can contain two `ApiKeyAuthScheme` instances with different names or locations; class-only restoration finds the first stored entry for both and silently applies the wrong credential.

For new integrations, derive a slot from the requirement-group position, scheme position, class, and public parameters:

```typescript
function credentialSlot(
  groupIndex: number,
  schemeIndex: number,
  scheme: AuthScheme,
): string {
  const params = 'params' in scheme
    ? (scheme as AuthScheme & { readonly params: unknown }).params
    : {};
  return JSON.stringify([groupIndex, schemeIndex, scheme.constructor.name, params]);
}
```

Store the selected `groupIndex` on the provider so `refresh(schemes)` can recreate the same slot keys. If the card's ordering or public parameters change, old entries no longer match and the provider falls back to interactive resolution instead of binding a credential to a different slot.

### Credential extraction

`AuthScheme` stores the credential in a `protected` field. The CLI doesn't cast past it — instead it invokes `applyToRequest` against a dummy context and reads the credential back out of the headers / URL:

```typescript
function extractCredential(slot: string, scheme: AuthScheme): { slot: string; credential: string } {
  const ctx = { headers: {} as Record<string, string>, url: new URL('http://dummy') };
  scheme.applyToRequest(ctx);

  let credential = '';
  if (scheme instanceof ApiKeyAuthScheme) {
    if (scheme.params.location === 'cookie') {
      const cookie = ctx.headers.Cookie ?? '';
      const pair = cookie.split(';').map(value => value.trim()).find(value => {
        const separator = value.indexOf('=');
        return separator >= 0 && value.slice(0, separator) === scheme.params.name;
      });
      credential = pair ? pair.slice(pair.indexOf('=') + 1) : '';
    } else {
      credential = ctx.headers[scheme.params.name]
        ?? ctx.url.searchParams.get(scheme.params.name)
        ?? '';
    }
  } else {
    // Bearer-style: extract token from "Bearer xxx" or "Basic xxx"
    const auth = ctx.headers['Authorization'] ?? '';
    const spaceIdx = auth.indexOf(' ');
    credential = spaceIdx >= 0 ? auth.slice(spaceIdx + 1) : auth;
  }
  return { slot, credential };
}
```

This keeps the provider agnostic of each scheme's private state — if the SDK adds a new scheme that uses, say, a `X-Custom-Auth` header, the extractor logic can be extended without changes elsewhere.

### Group-level, not scheme-level, matching

Restoration is all-or-nothing per group:

```typescript
for (const [groupIndex, group] of requirements.entries()) {
  if (this._tryRestore(groupIndex, group, stored)) {
    this.selectedGroupIndex = groupIndex;
    return group;
  }
}
```

If the agent requires `apiKey AND bearer` (AND within a group) and the store has only `apiKey`, the group fails to restore — the CLI falls through to Step 2 for the whole group, not just the missing piece. This avoids "half-restored" state where one scheme has a valid credential and another is uninitialized.

### Refresh is NOT the same as re-provide

When a task-creating response reports `auth-required`, the SDK only calls `refresh(schemes)` — passing the already-resolved scheme array. It does not re-call `provide(requirements)`. So `refresh` does not get to pick a different group; it re-runs the same group with fresh credentials.

An HTTP 401 is a transport failure, not this refresh signal. `A2XClient` throws it as `InternalError` without invoking the provider.

Consequence: if the user's stored credentials are stale **AND** that scheme group is no longer acceptable (e.g. agent added an AND requirement), `refresh` alone cannot recover. The CLI's `refresh` still works for the common case (one scheme in the group, credential expired) which is the important one.

---

## Full CLI Reference (Condensed)

Install a TTY-aware masked prompt: `npm install @inquirer/prompts`.

```typescript
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { password } from '@inquirer/prompts';
import type { AuthProvider } from '@a2x/sdk/client';
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
import {
  clearCredentials,
  credentialSlot,
  extractCredential,
  loadCredentials,
  saveCredentials,
} from './token-store.js';
import { performDeviceCodeFlow } from './device-code.js';

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function promptSecret(message: string): Promise<string> {
  return (await password({ message, mask: '*' })).trim();
}

async function resolveScheme(scheme: AuthScheme): Promise<void> {
  if (scheme instanceof ApiKeyAuthScheme) {
    const key = await promptSecret(`Enter API key (${scheme.params.name})`);
    if (!key) throw new Error('No API key provided');
    scheme.setCredential(key);
    return;
  }
  if (scheme instanceof HttpBearerAuthScheme) {
    const token = await promptSecret('Enter Bearer token');
    if (!token) throw new Error('No token provided');
    scheme.setCredential(token);
    return;
  }
  if (scheme instanceof HttpBasicAuthScheme) {
    const cred = await promptSecret('Enter Basic credentials (base64)');
    if (!cred) throw new Error('No credentials provided');
    scheme.setCredential(cred);
    return;
  }
  if (scheme instanceof OAuth2DeviceCodeAuthScheme) {
    const tokens = await performDeviceCodeFlow(scheme, process.env.OAUTH_CLIENT_ID!);
    scheme.setCredential(tokens.access_token);
    return;
  }
  if (
    scheme instanceof OAuth2AuthorizationCodeAuthScheme ||
    scheme instanceof OAuth2ClientCredentialsAuthScheme ||
    scheme instanceof OAuth2ImplicitAuthScheme ||
    scheme instanceof OAuth2PasswordAuthScheme
  ) {
    const token = await promptSecret('Enter access token');
    if (!token) throw new Error('No token provided');
    scheme.setCredential(token);
    return;
  }
  if (scheme instanceof OpenIdConnectAuthScheme) {
    const token = await promptSecret('Enter OIDC token');
    if (!token) throw new Error('No token provided');
    scheme.setCredential(token);
    return;
  }
  throw new Error(`Unsupported auth scheme: ${scheme.constructor.name}`);
}

export class CliAuthProvider implements AuthProvider {
  private selectedGroupIndex?: number;

  constructor(private readonly policyKey: string) {}

  async provide(requirements: AuthScheme[][]): Promise<AuthScheme[]> {
    const stored = loadCredentials(this.policyKey);
    if (stored?.length) {
      for (const [groupIndex, group] of requirements.entries()) {
        if (this._tryRestore(groupIndex, group, stored)) {
          this.selectedGroupIndex = groupIndex;
          return group;
        }
      }
    }

    let groupIndex: number;
    if (requirements.length === 1) {
      groupIndex = 0;
    } else {
      // render menu, read user choice → index
      groupIndex = /* parseInt from prompt */ 0;
    }
    const group = requirements[groupIndex];
    for (const scheme of group) await resolveScheme(scheme);
    this.selectedGroupIndex = groupIndex;
    this._save(groupIndex, group);
    return group;
  }

  async refresh(schemes: AuthScheme[]): Promise<AuthScheme[]> {
    if (this.selectedGroupIndex === undefined) {
      throw new Error('Cannot refresh before selecting an auth group');
    }
    clearCredentials(this.policyKey);
    for (const scheme of schemes) await resolveScheme(scheme);
    this._save(this.selectedGroupIndex, schemes);
    return schemes;
  }

  private _tryRestore(
    groupIndex: number,
    group: AuthScheme[],
    stored: Array<{ slot: string; credential: string }>,
  ): boolean {
    for (const [schemeIndex, scheme] of group.entries()) {
      const slot = credentialSlot(groupIndex, schemeIndex, scheme);
      const match = stored.find(s => s.slot === slot);
      if (!match) return false;
      scheme.setCredential(match.credential);
    }
    return true;
  }

  private _save(groupIndex: number, group: AuthScheme[]): void {
    const entries = group.map((scheme, schemeIndex) =>
      extractCredential(credentialSlot(groupIndex, schemeIndex, scheme), scheme),
    );
    saveCredentials(this.policyKey, entries);
  }
}
```

Use ordinary `readline` only for non-secret menu choices. Do not fall back to echoed input when stdin is not an interactive TTY; require a secret through a protected environment, file descriptor, or credential store instead.

For the token-store implementation and `extractCredential` helper, see [token-persistence.md](./token-persistence.md). For the device-code polling loop, see [oauth2-device-code.md](./oauth2-device-code.md).

---

## Variations by Host

| Host | Step 1 (stored) | Step 2 (interactive) | Step 3 (refresh) |
|------|-----------------|----------------------|-------------------|
| **CLI** | File store (`~/.a2x/tokens.json`) | readline prompts + device-code polling | Clear store + re-prompt |
| **Backend daemon** | In-memory map + secret manager | None — throw if env is incomplete | Re-read env / secret manager |
| **Next.js route** | Session cookie / Redis | None — return 401 to client, triggering UI re-auth | Invalidate session |
| **Browser SPA** | `localStorage` / in-memory | `window.location` redirect | Redirect to login |

The CLI's chain is the most feature-complete. Backends can drop Step 2 entirely; browsers offload Step 2 to a redirect and treat Step 3 as a forced redirect.
