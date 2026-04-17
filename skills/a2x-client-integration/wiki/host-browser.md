# Host: Browser (SPA)

`@a2x/sdk/client` is isomorphic — `A2XClient` works in the browser. But **you usually shouldn't call agents directly from the browser**. This page covers when it's okay, the constraints, and the recommended architectural alternatives.

---

## When Direct Browser Calls Are OK

- The agent is **your own**, served on the same origin (no CORS issues) or has explicit CORS headers for your origin.
- The credentials are **per-user and short-lived** (e.g. a bearer token issued by your auth provider after login).
- You're building a **developer tool / demo** where the user pastes in their own token.

## When They're NOT OK

- The agent requires an API key that represents **your** service identity — that key would be visible in network inspector and shippable to every user.
- The agent is on a different origin that doesn't send `Access-Control-Allow-Origin`.
- You need `OAuth2ClientCredentialsAuthScheme` — the client secret cannot live in a browser.
- You need persistent credentials across logins — `localStorage` is XSS-vulnerable.

For these cases, [proxy through a backend](./host-nextjs.md) and let the browser call your own API.

---

## Minimal Browser Setup

```typescript
// src/lib/agent.ts
import { A2XClient } from '@a2x/sdk/client';
import type { AuthProvider } from '@a2x/sdk/client';
import { AuthScheme, HttpBearerAuthScheme } from '@a2x/sdk/client';

class SessionBearerProvider implements AuthProvider {
  constructor(private readonly getToken: () => string | null) {}

  async provide(requirements: AuthScheme[][]): Promise<AuthScheme[]> {
    const token = this.getToken();
    if (!token) throw new Error('Not signed in');

    for (const group of requirements) {
      if (group.length === 1 && group[0] instanceof HttpBearerAuthScheme) {
        group[0].setCredential(token);
        return group;
      }
    }
    throw new Error('Agent does not accept a bearer token');
  }

  async refresh(): Promise<AuthScheme[]> {
    // Token expired — force the app to re-authenticate via your login flow.
    window.location.href = '/login?reason=expired';
    // Never resolves; redirect aborts the flow.
    return new Promise(() => {});
  }
}

export function makeAgentClient(getToken: () => string | null) {
  return new A2XClient(import.meta.env.VITE_AGENT_URL, {
    authProvider: new SessionBearerProvider(getToken),
  });
}
```

---

## CORS Requirements

The remote agent must send:

```
Access-Control-Allow-Origin: https://your-app.example.com
Access-Control-Allow-Headers: Content-Type, Authorization, x-api-key
Access-Control-Allow-Methods: GET, POST, OPTIONS
```

…and respond to `OPTIONS` preflight requests. The built-in `toA2x` server emits `Access-Control-Allow-Origin: *` and handles `OPTIONS`. Servers behind reverse proxies may need manual CORS config.

Streaming (`message/stream`) triggers a preflight because the client sends `Accept: text/event-stream` and a JSON body — the preflight must succeed or the browser will never open the SSE connection.

---

## Token Storage Options

| Option | XSS-safe? | Survives reload? | Notes |
|--------|-----------|------------------|-------|
| `localStorage` | No | Yes | Simplest; XSS can exfiltrate |
| `sessionStorage` | No | Only within tab | Slightly better blast radius |
| In-memory only | Yes | No | Forces re-login on reload |
| Cookie with `HttpOnly` | Yes | Yes | You can't read it from JS — useful only if the **agent** accepts the cookie |
| Service worker + IndexedDB | Mostly | Yes | Complex; niche |

For user-pasted tokens in a dev tool, in-memory is fine. For production sessions, prefer `HttpOnly` cookies with server-side proxy.

---

## Streaming in the Browser

`sendMessageStream` works in the browser via the Fetch Streaming API — supported in all modern browsers.

```typescript
import { A2XClient } from '@a2x/sdk/client';
import type { SendMessageParams } from '@a2x/sdk';

async function run(client: A2XClient, text: string, onChunk: (t: string) => void) {
  const params: SendMessageParams = {
    message: {
      messageId: crypto.randomUUID(),
      role: 'user',
      parts: [{ text }],
    },
  };

  for await (const event of client.sendMessageStream(params)) {
    if ('artifact' in event) {
      for (const part of event.artifact.parts) {
        if ('text' in part) onChunk(part.text);
      }
    }
  }
}
```

`crypto.randomUUID()` is available in secure contexts (HTTPS, localhost). For legacy contexts, use `uuid` from npm.

---

## React Usage (Sketch)

```tsx
import { useCallback, useState } from 'react';
import { makeAgentClient } from './lib/agent';
import { useAuth } from './lib/use-auth';  // your auth hook

export function ChatInput() {
  const { accessToken } = useAuth();
  const [busy, setBusy] = useState(false);
  const [output, setOutput] = useState('');

  const onSubmit = useCallback(async (form: FormData) => {
    setBusy(true);
    setOutput('');
    const client = makeAgentClient(() => accessToken);

    try {
      for await (const event of client.sendMessageStream({
        message: {
          messageId: crypto.randomUUID(),
          role: 'user',
          parts: [{ text: form.get('message') as string }],
        },
      })) {
        if ('artifact' in event) {
          for (const part of event.artifact.parts) {
            if ('text' in part) setOutput(s => s + part.text);
          }
        }
      }
    } finally {
      setBusy(false);
    }
  }, [accessToken]);

  return (
    <form action={onSubmit}>
      <textarea name="message" />
      <button disabled={busy}>Send</button>
      <pre>{output}</pre>
    </form>
  );
}
```

Memoize the client if the token is stable:

```typescript
const client = useMemo(() => makeAgentClient(() => accessToken), [accessToken]);
```

---

## OAuth2 Flows

Only `OAuth2AuthorizationCodeAuthScheme` (with PKCE) and `OAuth2ImplicitAuthScheme` are viable in a pure browser context. Both require a redirect to the authorization server. The SDK does not run these flows for you.

Recommended approach: **don't run OAuth2 from a provider impl**. Use a proper OIDC library (e.g. `oidc-client-ts`) for the login flow, store the resulting access token somewhere, and provide a simple `SessionBearerProvider` that reads from there.

Attempting to run `OAuth2DeviceCodeAuthScheme` from a browser is possible but weird — there's no terminal to display the code. Render it in the UI instead:

```tsx
// Pseudo — you'd implement performDeviceCodeFlow with UI callbacks
async function performDeviceCodeFlow(scheme, callbacks) {
  const deviceData = /* POST device_authorization_url */;
  callbacks.onPrompt({
    verificationUri: deviceData.verification_uri_complete,
    userCode: deviceData.user_code,
  });
  // poll token_url until success
}
```

Again: almost always better to proxy through a backend.

---

## Bundler Considerations

`@a2x/sdk/client` imports only SDK-local modules plus Node built-ins (in the non-client subpaths). The client subpath itself is browser-safe:

- No `node:http` / `node:fs` in the client code path
- No CommonJS-only dependencies
- ESM-first with bundled `.d.ts`

For Vite / esbuild / webpack 5: no special config. For older bundlers without conditional exports support, import from `@a2x/sdk/client` explicitly rather than `@a2x/sdk`.
