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
import {
  A2XClient,
  getAgentEndpointUrl,
  resolveAgentCard,
} from '@a2x/sdk/client';
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

function requireJsonRpcEndpoint(card: unknown, version: '0.3' | '1.0'): string {
  if (version === '1.0') {
    const interfaces = (card as {
      supportedInterfaces?: Array<{ url: string; protocolBinding?: string }>;
    }).supportedInterfaces ?? [];
    const jsonRpc = interfaces.find(entry =>
      entry.protocolBinding?.toUpperCase() === 'JSONRPC'
    );
    if (!jsonRpc) throw new Error('AgentCard has no JSON-RPC interface');
    return jsonRpc.url;
  }
  return getAgentEndpointUrl(card as Parameters<typeof getAgentEndpointUrl>[0], version);
}

export async function makeAgentClient(getToken: () => string | null) {
  const exactBrowserUrl = (raw: string, label: string) => {
    const url = new URL(raw);
    if (
      url.protocol !== 'https:' || url.username || url.password ||
      url.search || url.hash
    ) throw new Error(`${label} must be an exact credential-free HTTPS URL`);
    return url.toString();
  };
  const cardUrl = exactBrowserUrl(
    import.meta.env.VITE_AGENT_CARD_URL,
    'VITE_AGENT_CARD_URL',
  );
  if (!new URL(cardUrl).pathname.endsWith('.json')) {
    throw new Error('VITE_AGENT_CARD_URL must name one exact JSON document');
  }
  const expectedEndpoint = exactBrowserUrl(
    import.meta.env.VITE_AGENT_ENDPOINT_URL,
    'VITE_AGENT_ENDPOINT_URL',
  );
  const noRedirectFetch: typeof fetch = (input, init) =>
    fetch(input, { ...init, redirect: 'error' });
  const resolved = await resolveAgentCard(cardUrl, { fetch: noRedirectFetch });
  const endpoint = exactBrowserUrl(
    requireJsonRpcEndpoint(resolved.card, resolved.version),
    'AgentCard endpoint',
  );
  if (endpoint !== expectedEndpoint) {
    throw new Error(`AgentCard endpoint is not approved: ${endpoint}`);
  }
  // This production pattern is same-origin. A deliberate cross-origin
  // deployment needs its own exact-origin policy plus the CORS rules below.
  if (new URL(endpoint).origin !== window.location.origin) {
    throw new Error('Agent endpoint is not same-origin');
  }
  return new A2XClient(resolved.card, {
    fetch: noRedirectFetch,
    authProvider: new SessionBearerProvider(getToken),
  });
}
```

---

## CORS Requirements

The remote agent must send:

```
Access-Control-Allow-Origin: https://your-app.example.com
Access-Control-Allow-Headers: Content-Type, Authorization, X-A2A-Extensions, x-api-key
Access-Control-Allow-Methods: GET, POST, OPTIONS
```

…and respond to `OPTIONS` preflight requests. Replace `x-api-key` with every custom API-key header name the card can select. The built-in `toA2x` listener emits `Access-Control-Allow-Origin: *` and handles `OPTIONS`, but its default `Access-Control-Allow-Headers` permits only `Content-Type`. Browser calls using authentication, custom, extension, or x402 headers therefore need a reverse proxy or host wrapper that returns the complete allow-list.

Streaming (`message/stream`) typically triggers a preflight because the POST uses a non-safelisted JSON `Content-Type`; authentication, extension, and custom API-key headers can also require it. `Accept: text/event-stream` is CORS-safelisted and does not trigger preflight by itself. The preflight must succeed or the browser will never open the SSE connection.

---

## Token Storage Options

| Option | Resists same-origin XSS token theft? | Survives reload? | Notes |
|--------|---------------------------------------|------------------|-------|
| `localStorage` | No | Yes | XSS can read and exfiltrate it |
| `sessionStorage` | No | Only within tab | Smaller persistence window, same XSS boundary |
| In-memory only | No | No | Shorter exposure window, but XSS can read or intercept a live token |
| Cookie with `HttpOnly` | Yes, for token confidentiality | Yes | JavaScript cannot read it, but XSS can still issue same-origin requests; useful only if the **agent** accepts the cookie |
| Service worker + IndexedDB | No | Yes | Same-origin script compromise can still reach or misuse the credential path |

For user-pasted tokens in a dev tool, in-memory is fine. For production sessions, prefer `HttpOnly` cookies with server-side proxy.

---

## x402 Signer Boundary

Native x402 payment requires a viem `LocalAccount`, which holds signing authority in the JavaScript process. Do not place a platform or service private key in a SPA bundle, browser storage, or remotely supplied configuration. An injected wallet account is not automatically a drop-in `LocalAccount` for this API.

For direct browser payment, use only a user-owned signer with intentionally limited funds and clear per-payment consent. Otherwise proxy the payment through a backend payer with server-side policy, rate limits, and an aggregate budget in addition to the SDK's per-requirement `maxAmount`.

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
    const client = await makeAgentClient(() => accessToken);

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

For repeated calls, cache the validated card and endpoint policy separately,
then construct a synchronous per-token client. Do not treat the promise returned
by `makeAgentClient()` as an `A2XClient`.

---

## OAuth2 Flows

Only `OAuth2AuthorizationCodeAuthScheme` (with PKCE) and `OAuth2ImplicitAuthScheme` are viable in a pure browser context. Both require a redirect to the authorization server. The SDK does not run these flows for you.

Recommended approach: **don't run OAuth2 from a provider impl**. Use a proper OIDC library (e.g. `oidc-client-ts`) for the login flow, store the resulting access token somewhere, and provide a simple `SessionBearerProvider` that reads from there.

Configure the library with an expected HTTPS issuer, exact endpoints, client identity, audience/resource, and exact requested scopes from application policy. The current SDK does not preserve selected security-requirement values on normalized schemes, so do not derive the request from `scheme.params.scopes`; use the host-configured set after verifying it against the approved raw card and advertised catalogue. Reject cross-origin redirects before sending credentials or showing a login link.

Attempting to run `OAuth2DeviceCodeAuthScheme` from a browser is possible but weird — there's no terminal to display the code. Render it in the UI instead:

```tsx
// Pseudo — you'd implement performDeviceCodeFlow with UI callbacks
async function performDeviceCodeFlow(scheme, callbacks) {
  const deviceUrl = requireConfiguredOAuthEndpoint(scheme.params.deviceAuthorizationUrl);
  const tokenUrl = requireConfiguredOAuthEndpoint(scheme.params.tokenUrl);
  const scopes = requireAllowedScopes(
    HOST_REQUIRED_SCOPES,
    scheme.params.scopes,
  );
  const deviceData = /* POST deviceUrl with redirect: 'error' */;
  const verificationUri = requireConfiguredVerificationOrigin(
    deviceData.verification_uri_complete ?? deviceData.verification_uri,
  );
  callbacks.onPrompt({
    verificationUri: verificationUri.toString(),
    userCode: deviceData.user_code,
  });
  // poll tokenUrl with redirect: 'error' until success
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
