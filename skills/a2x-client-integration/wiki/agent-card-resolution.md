# Agent Card Resolution

How `A2XClient` discovers the remote agent's card, protocol version, and endpoint URL.

---

## The Three URL Forms

`A2XClient` (and the standalone `resolveAgentCard`) accept any of these:

### 1. Full card URL ending in `.json`

```typescript
new A2XClient('https://agent.example.com/.well-known/agent.json');
```

The SDK parses the origin and path, fetches that exact URL. No well-known fallback.

### 2. Base URL + explicit path option

```typescript
import { resolveAgentCard } from '@a2x/sdk/client';

const resolved = await resolveAgentCard('https://agent.example.com', {
  path: '/agents/my-agent/card',
});
```

`A2XClient` does not expose a `path` option — use `resolveAgentCard` standalone if you need a non-well-known path, then pass the **resolved card** to `A2XClient`:

```typescript
const resolved = await resolveAgentCard(baseUrl, { path: customPath });
const client = new A2XClient(resolved.card, { authProvider });
```

### 3. Base URL only — well-known fallback

```typescript
new A2XClient('https://agent.example.com');
```

The SDK tries these paths **in order**, returning the first success:

1. `/.well-known/agent.json`
2. `/.well-known/agent-card.json`

If both fail, the error includes both attempted paths and the last error message.

---

## Protocol Version Detection

`detectProtocolVersion(card)` inspects the card:

```typescript
if (typeof card.protocolVersion === 'string') {
  if (card.protocolVersion.startsWith('0.3')) return '0.3';
  if (card.protocolVersion.startsWith('1.')) return '1.0';
}
if (Array.isArray(card.supportedInterfaces) && card.supportedInterfaces.length > 0) {
  return '1.0';
}
if (typeof card.url === 'string') {
  return '0.3';
}
return '1.0';  // ambiguous default
```

Notes:

- The card's declared `protocolVersion` is authoritative when recognized.
- v1.0 cards have `supportedInterfaces: [{ url, protocolBinding, … }, …]`.
- v0.3 cards have a top-level `url` (the JSON-RPC endpoint).
- A v0.3 card may also advertise `supportedInterfaces`; it remains v0.3 when `protocolVersion` declares `0.3.x`.
- Shape heuristics are used only when the declaration is absent or unrecognized.

---

## Endpoint URL Extraction

`getAgentEndpointUrl(card, version)` picks the JSON-RPC endpoint:

- **v0.3** — use `card.url`. Throws if absent.
- **v1.0** — find the interface with `protocolBinding` (case-insensitive) `JSONRPC`; if none matches, the current SDK falls back to the first interface.

The fallback is unsafe for a JSON-RPC-only client: it can post JSON-RPC to a
gRPC or HTTP+JSON endpoint. Before attaching credentials, inspect a v1.0 card
yourself and reject it unless it advertises an explicit JSON-RPC interface.
The policy-bound examples in this skill perform that preflight. The SDK fix is
tracked in [#240](https://github.com/planetarium/a2x/issues/240).

---

## Manually Using the Resolver

When you want to preview the card before connecting:

```typescript
import { resolveAgentCard, detectProtocolVersion } from '@a2x/sdk/client';

const resolved = await resolveAgentCard(AGENT_URL, {
  fetch: globalThis.fetch,        // optional
  headers: { 'Accept-Language': 'en' }, // optional, sent on the card GET
});

console.log({
  version: resolved.version,
  baseUrl: resolved.baseUrl,      // origin derived from the card URL
  card: resolved.card,
});

// Inspect security requirements before connecting
const card = resolved.card as Record<string, unknown>;
const requirements = card.securityRequirements ?? card.security ?? [];
```

---

## Card Caching

`A2XClient` caches the resolved card on the instance. `resolveAgentCard` does **no** caching by itself — every call is a fresh HTTP GET.

If you need card caching at the application layer (e.g. to avoid repeated GETs when you create short-lived clients), call `resolveAgentCard` once, then pass the resolved card to `A2XClient`:

```typescript
import {
  A2XClient,
  getAgentEndpointUrl,
  resolveAgentCard,
} from '@a2x/sdk/client';

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

// once, e.g. at app startup
const noRedirectFetch: typeof fetch = (input, init) =>
  fetch(input, { ...init, redirect: 'error' });
const resolved = await resolveAgentCard(AGENT_CARD_URL, {
  fetch: noRedirectFetch,
});
const endpoint = requireJsonRpcEndpoint(resolved.card, resolved.version);
if (endpoint !== EXPECTED_AGENT_ENDPOINT) {
  throw new Error(`AgentCard endpoint is not approved: ${endpoint}`);
}

// later, per request
function makeClient() {
  return new A2XClient(resolved.card, {
    authProvider,
    fetch: noRedirectFetch,
  });
}
```

`AGENT_CARD_URL` and `EXPECTED_AGENT_ENDPOINT` must be exact host-policy values.
Never restore or attach credentials until this binding succeeds.

When you pass an `AgentCard` object instead of a URL, `A2XClient` skips the HTTP GET entirely. It still runs `detectProtocolVersion` and `getAgentEndpointUrl` to derive routing info.

---

## Constants

```typescript
import {
  AGENT_CARD_WELL_KNOWN_PATH,       // '/.well-known/agent.json'
  AGENT_CARD_WELL_KNOWN_PATH_ALT,   // '/.well-known/agent-card.json'
} from '@a2x/sdk/client';
```

Useful if you want to construct URLs or log what was tried.

---

## Custom fetch

```typescript
const resolved = await resolveAgentCard(AGENT_URL, {
  fetch: async (input, init) => {
    // e.g. add telemetry, timeouts, proxy
    return globalThis.fetch(input, { ...init, signal: AbortSignal.timeout(5_000) });
  },
});
```

The same option is available on `A2XClient`. A common pattern is a shared custom-fetch that wraps `globalThis.fetch` with timeouts and retry logic for **idempotent** operations.
