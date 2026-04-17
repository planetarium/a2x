# Authentication Fallback Chain

This is the **reference pattern** for an interactive `AuthProvider` — lifted directly from the `a2x` CLI implementation at `packages/cli/src/cli-auth-provider.ts`. Use it as the blueprint for any interactive client (CLI, TUI, dev tools) that must survive restarts and token expiry.

---

## The Three-Step Chain

```
provide(requirements)
  │
  │   ── Step 1: Stored credentials ────────────────────────────────────────
  │     loadCredentials(agentUrl) → Array<{ schemeClass, credential }>
  │     for each group in requirements:
  │       if all schemes in group have a stored match by class name:
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
  │     saveCredentials(agentUrl, group.map(extractCredential))
  │     return group

refresh(schemes)   ← SDK calls after HTTP 401
  │
  │   ── Step 3: Invalidate and re-prompt ──────────────────────────────
  │     clearCredentials(agentUrl)
  │
  │     for each scheme in schemes:
  │       resolveScheme(scheme)   ← same interactive UI as Step 2
  │
  │     saveCredentials(agentUrl, schemes.map(extractCredential))
  │     return schemes
```

---

## Why Three Steps

Each step addresses a distinct failure mode:

| Step | Failure it covers |
|------|-------------------|
| 1. Stored | **Second-run friction.** Without persistence, the user re-authenticates on every CLI invocation. |
| 2. Interactive | **First-run bootstrap.** Stored credentials don't exist yet, or the user switched to a different agent. |
| 3. Refresh | **Credential expiry.** Stored token worked last time, but the agent now returns 401 — stored credentials are stale. |

Skipping Step 1 is fine for short-lived workers that always re-prompt anyway (none, for a backend service). Skipping Step 3 leaves you vulnerable to stale tokens — any OAuth2-backed agent benefits from it.

---

## Key Implementation Details

### Scheme class name as stable key

The CLI stores credentials keyed by `scheme.constructor.name` and matches on that when restoring:

```typescript
// Save
const entries = group.map(scheme => ({
  schemeClass: scheme.constructor.name,
  credential: extractCredential(scheme),
}));

// Restore
for (const scheme of group) {
  const match = stored.find(s => s.schemeClass === scheme.constructor.name);
  if (!match) return false;           // this group can't be restored
  scheme.setCredential(match.credential);
}
```

This works because the SDK **always** instantiates the same `AuthScheme` subclass from the same agent-card security entry. As long as the agent card does not change, the class name is a stable identifier for the credential slot.

If the agent later rotates to a different scheme type (say, API key → Bearer), stored entries won't match and the CLI falls through to the interactive step — which is the right behavior.

### Credential extraction

`AuthScheme` stores the credential in a `protected` field. The CLI doesn't cast past it — instead it invokes `applyToRequest` against a dummy context and reads the credential back out of the headers / URL:

```typescript
function extractCredential(scheme: AuthScheme): { schemeClass: string; credential: string } {
  const ctx = { headers: {} as Record<string, string>, url: new URL('http://dummy') };
  scheme.applyToRequest(ctx);

  let credential = '';
  if (scheme instanceof ApiKeyAuthScheme) {
    credential = ctx.headers[scheme.params.name]
      ?? ctx.url.searchParams.get(scheme.params.name)
      ?? '';
  } else {
    // Bearer-style: extract token from "Bearer xxx" or "Basic xxx"
    const auth = ctx.headers['Authorization'] ?? '';
    const spaceIdx = auth.indexOf(' ');
    credential = spaceIdx >= 0 ? auth.slice(spaceIdx + 1) : auth;
  }
  return { schemeClass: scheme.constructor.name, credential };
}
```

This keeps the provider agnostic of each scheme's private state — if the SDK adds a new scheme that uses, say, a `X-Custom-Auth` header, the extractor logic can be extended without changes elsewhere.

### Group-level, not scheme-level, matching

Restoration is all-or-nothing per group:

```typescript
for (const group of requirements) {
  if (this._tryRestore(group, stored)) {
    return group;
  }
}
```

If the agent requires `apiKey AND bearer` (AND within a group) and the store has only `apiKey`, the group fails to restore — the CLI falls through to Step 2 for the whole group, not just the missing piece. This avoids "half-restored" state where one scheme has a valid credential and another is uninitialized.

### Refresh is NOT the same as re-provide

The SDK only calls `refresh(schemes)` — passing the already-resolved scheme array. It does not re-call `provide(requirements)`. So `refresh` does not get to pick a different group; it re-runs the same group with fresh credentials.

Consequence: if the user's stored credentials are stale **AND** that scheme group is no longer acceptable (e.g. agent added an AND requirement), `refresh` alone cannot recover. The CLI's `refresh` still works for the common case (one scheme in the group, credential expired) which is the important one.

---

## Full CLI Reference (Condensed)

```typescript
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
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
import { loadCredentials, saveCredentials, clearCredentials } from './token-store.js';
import { performDeviceCodeFlow } from './device-code.js';

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function resolveScheme(scheme: AuthScheme): Promise<void> {
  if (scheme instanceof ApiKeyAuthScheme) {
    const key = await prompt(`Enter API key (${scheme.params.name}): `);
    if (!key) throw new Error('No API key provided');
    scheme.setCredential(key);
    return;
  }
  if (scheme instanceof HttpBearerAuthScheme) {
    const token = await prompt('Enter Bearer token: ');
    if (!token) throw new Error('No token provided');
    scheme.setCredential(token);
    return;
  }
  if (scheme instanceof HttpBasicAuthScheme) {
    const cred = await prompt('Enter Basic credentials (base64): ');
    if (!cred) throw new Error('No credentials provided');
    scheme.setCredential(cred);
    return;
  }
  if (scheme instanceof OAuth2DeviceCodeAuthScheme) {
    const token = await performDeviceCodeFlow(scheme);
    scheme.setCredential(token);
    return;
  }
  if (
    scheme instanceof OAuth2AuthorizationCodeAuthScheme ||
    scheme instanceof OAuth2ClientCredentialsAuthScheme ||
    scheme instanceof OAuth2ImplicitAuthScheme ||
    scheme instanceof OAuth2PasswordAuthScheme
  ) {
    const token = await prompt('Enter access token: ');
    if (!token) throw new Error('No token provided');
    scheme.setCredential(token);
    return;
  }
  if (scheme instanceof OpenIdConnectAuthScheme) {
    const token = await prompt('Enter OIDC token: ');
    if (!token) throw new Error('No token provided');
    scheme.setCredential(token);
    return;
  }
  throw new Error(`Unsupported auth scheme: ${scheme.constructor.name}`);
}

export class CliAuthProvider implements AuthProvider {
  constructor(private readonly agentUrl: string) {}

  async provide(requirements: AuthScheme[][]): Promise<AuthScheme[]> {
    const stored = loadCredentials(this.agentUrl);
    if (stored?.length) {
      for (const group of requirements) {
        if (this._tryRestore(group, stored)) return group;
      }
    }

    let group: AuthScheme[];
    if (requirements.length === 1) {
      group = requirements[0];
    } else {
      // render menu, read user choice → index
      const idx = /* parseInt from prompt */ 0;
      group = requirements[idx];
    }
    for (const scheme of group) await resolveScheme(scheme);
    this._save(group);
    return group;
  }

  async refresh(schemes: AuthScheme[]): Promise<AuthScheme[]> {
    clearCredentials(this.agentUrl);
    for (const scheme of schemes) await resolveScheme(scheme);
    this._save(schemes);
    return schemes;
  }

  private _tryRestore(
    group: AuthScheme[],
    stored: Array<{ schemeClass: string; credential: string }>,
  ): boolean {
    for (const scheme of group) {
      const match = stored.find(s => s.schemeClass === scheme.constructor.name);
      if (!match) return false;
      scheme.setCredential(match.credential);
    }
    return true;
  }

  private _save(group: AuthScheme[]): void {
    const entries = group.map(extractCredential);
    saveCredentials(this.agentUrl, entries);
  }
}
```

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
