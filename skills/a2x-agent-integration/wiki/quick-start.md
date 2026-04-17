# Quick Start with toA2x

`toA2x()` is a zero-framework helper that converts an `LlmAgent` into a fully working A2A server with a single function call. It includes a built-in HTTP server using Node.js `http` module — no Express, Next.js, or any framework needed.

---

## Minimal Example

```typescript
import { LlmAgent, toA2x } from '@a2x/sdk';
import { GoogleProvider } from '@a2x/sdk/google';

const agent = new LlmAgent({
  name: 'my-agent',
  description: 'A helpful assistant.',
  provider: new GoogleProvider({
    model: 'gemini-2.5-flash',
    apiKey: process.env.GOOGLE_API_KEY!,
  }),
  instruction: 'You are a helpful assistant.',
});

const { handler, a2xAgent, listen } = toA2x(agent, {
  defaultUrl: 'http://localhost:3000/a2a',
});

await listen(3000);
// Server running on http://localhost:3000
// Agent Card: GET http://localhost:3000/.well-known/agent.json
// JSON-RPC:   POST http://localhost:3000/a2a
```

---

## With Options

```typescript
import {
  LlmAgent,
  toA2x,
  StreamingMode,
  ApiKeyAuthorization,
} from '@a2x/sdk';
import { AnthropicProvider } from '@a2x/sdk/anthropic';

const agent = new LlmAgent({
  name: 'secure-agent',
  description: 'A secured assistant.',
  provider: new AnthropicProvider({
    model: 'claude-sonnet-4-20250514',
    apiKey: process.env.ANTHROPIC_API_KEY!,
  }),
  instruction: 'You are a helpful, secure assistant.',
});

const { handler, a2xAgent, listen } = toA2x(agent, {
  defaultUrl: 'http://localhost:4000/a2a',
  port: 4000,
  streamingMode: StreamingMode.SSE,
  protocolVersion: '1.0',
  skills: [
    {
      id: 'chat',
      name: 'General Chat',
      description: 'General conversation',
      tags: ['chat'],
    },
  ],
  securitySchemes: {
    apiKey: new ApiKeyAuthorization({
      in: 'header',
      name: 'x-api-key',
      keys: ['my-secret-key'],
    }),
  },
  securityRequirements: [{ apiKey: [] }],
});

await listen();  // Uses port from options (4000)
```

---

## ToA2xOptions

```typescript
interface ToA2xOptions {
  defaultUrl: string;                              // Required: base URL for AgentCard
  port?: number;                                    // Port for listen() (default: 3000)
  skills?: A2XAgentSkill[];                         // Skills to advertise
  streamingMode?: StreamingMode;                    // SSE or NONE (default: SSE)
  securitySchemes?: Record<string, BaseSecurityScheme>;
  securityRequirements?: SecurityRequirement[];
  protocolVersion?: '0.3' | '1.0';                 // Default protocol version
}
```

---

## ToA2xResult

```typescript
interface ToA2xResult {
  handler: DefaultRequestHandler;   // For custom HTTP integration
  a2xAgent: A2XAgent;              // For further configuration
  listen(port?: number): Promise<void>;  // Start the built-in HTTP server
}
```

You can use `handler` and `a2xAgent` directly if you want to integrate into an existing server, or call `listen()` for the built-in server.

---

## Built-in Server Features

The `listen()` method creates a Node.js HTTP server that handles:
- `GET /.well-known/agent.json` — AgentCard discovery (supports `?version=0.3` or `?version=1.0`)
- `POST /a2a` (or any POST) — JSON-RPC endpoint with SSE streaming
- `OPTIONS` — CORS preflight with `Access-Control-Allow-Origin: *`

---

## When to Use toA2x

- **Prototyping** — Quickest way to get an A2A agent running
- **Scripts / standalone agents** — Single-file A2A agents
- **Testing** — Spin up a test agent in CI

For production, use a proper framework (Express, Next.js, NestJS) with the full setup pattern.
