# @a2x/sdk

[![npm version](https://img.shields.io/npm/v/@a2x/sdk.svg)](https://www.npmjs.com/package/@a2x/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A self-contained TypeScript SDK for building [A2A (Agent-to-Agent)](https://a2a-protocol.org/) protocol agents with multi-provider LLM support, built-in authentication, and SSE streaming.

## Why a2x?

- **Auto-extraction** — `A2XAgent` infers AgentCard fields from your runtime objects. No manual JSON authoring.
- **Multi-version AgentCard** — Generate v0.3 and v1.0 AgentCards from the same instance.
- **Multi-provider** — Anthropic Claude, OpenAI GPT, and Google Gemini out of the box.
- **Framework-agnostic** — Works with Express, Fastify, Hono, Next.js, or any HTTP framework.
- **SSE streaming** — First-class `message/stream` support via Server-Sent Events.
- **Built-in auth** — API Key, Bearer, OAuth 2.0 (Authorization Code, Client Credentials, Device Code), OpenID Connect, and Mutual TLS.
- **x402 payments** — Charge per call via the [a2a-x402 v0.2](https://github.com/google-agentic-commerce/a2a-x402) extension. Supports both the Standalone gate (one charge at the door) and the Embedded flow (mid-execution per-action charges on artifacts, e.g. cart checkout). On-chain verify + settle through any x402 facilitator.
- **Zero runtime dependencies** — Core module uses only Node.js built-in APIs.
- **TypeScript-first** — Full type safety with types derived from A2A JSON Schema.

## Installation

```bash
npm install @a2x/sdk
```

Install the LLM provider SDK you plan to use:

```bash
# Pick one (or more)
npm install @google/genai        # Google Gemini
npm install @anthropic-ai/sdk    # Anthropic Claude
npm install openai               # OpenAI GPT
```

## Quick Start

```typescript
import { LlmAgent, toA2x } from '@a2x/sdk';
import { GoogleProvider } from '@a2x/sdk/google';

const agent = new LlmAgent({
  name: 'my_assistant',
  description: 'A helpful assistant.',
  instruction: 'You are a helpful assistant.',
  provider: new GoogleProvider({
    model: 'gemini-2.5-flash',
    apiKey: process.env.GOOGLE_API_KEY!,
  }),
});

const app = toA2x(agent, {
  port: 4000,
  defaultUrl: 'http://localhost:4000/a2a',
});
```

This starts an A2A-compliant server with:
- `GET /.well-known/agent.json` — Agent discovery
- `POST /a2a` — JSON-RPC endpoint (`message/send`, `message/stream`, `tasks/get`, `tasks/cancel`)

## Providers

### Google Gemini

```typescript
import { GoogleProvider } from '@a2x/sdk/google';

const provider = new GoogleProvider({
  model: 'gemini-2.5-flash',
  apiKey: process.env.GOOGLE_API_KEY!,
});
```

### Anthropic Claude

```typescript
import { AnthropicProvider } from '@a2x/sdk/anthropic';

const provider = new AnthropicProvider({
  model: 'claude-sonnet-4-20250514',
  apiKey: process.env.ANTHROPIC_API_KEY!,
});
```

### OpenAI GPT

```typescript
import { OpenAIProvider } from '@a2x/sdk/openai';

const provider = new OpenAIProvider({
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY!,
});
```

## Server Setup (Manual Wiring)

For full control over routing and middleware:

```typescript
import {
  LlmAgent,
  InMemoryRunner,
  AgentExecutor,
  StreamingMode,
  InMemoryTaskStore,
  A2XAgent,
  DefaultRequestHandler,
  createSSEStream,
} from '@a2x/sdk';
import type { RequestContext } from '@a2x/sdk';
import { GoogleProvider } from '@a2x/sdk/google';

// 1. Define your agent
const agent = new LlmAgent({
  name: 'my_agent',
  description: 'My A2A agent.',
  instruction: 'You are a helpful assistant.',
  provider: new GoogleProvider({
    model: 'gemini-2.5-flash',
    apiKey: process.env.GOOGLE_API_KEY!,
  }),
});

// 2. Wire up the runtime
const runner = new InMemoryRunner({ agent, appName: agent.name });
const executor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
});
const taskStore = new InMemoryTaskStore();

// 3. Create A2XAgent (auto-extracts name, description, streaming from runtime)
const a2xAgent = new A2XAgent({ taskStore, executor })
  .setDefaultUrl('https://my-agent.example.com/a2a')
  .addSkill({
    id: 'chat',
    name: 'Chat',
    description: 'General conversation',
    tags: ['chat'],
  });

// 4. Create the request handler
const handler = new DefaultRequestHandler(a2xAgent);
```

### Express

```typescript
import express from 'express';

const app = express();
app.use(express.json());

app.get('/.well-known/agent.json', (req, res) => {
  res.json(handler.getAgentCard());
});

app.post('/a2a', async (req, res) => {
  const context: RequestContext = { headers: req.headers, query: req.query };
  const result = await handler.handle(req.body, context);

  if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    const stream = createSSEStream(result);
    const reader = stream.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(typeof value === 'string' ? value : new TextDecoder().decode(value));
    }
    res.end();
  } else {
    res.json(result);
  }
});

app.listen(4000);
```

### Next.js App Router

```typescript
export async function GET() {
  return Response.json(handler.getAgentCard());
}

export async function POST(request: Request) {
  const body = await request.json();
  const result = await handler.handle(body);

  if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
    const stream = createSSEStream(result);
    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
    });
  }
  return Response.json(result);
}
```

## Client

```typescript
import { A2XClient } from '@a2x/sdk/client';

const client = new A2XClient('https://agent.example.com/.well-known/agent.json');

// Send a message
const task = await client.sendMessage({
  message: { role: 'user', parts: [{ text: 'Hello!' }] },
});

// Stream a response
for await (const event of client.sendMessageStream({
  message: { role: 'user', parts: [{ text: 'Tell me a story' }] },
})) {
  console.log(event);
}

// Task management
const existing = await client.getTask('task-id');
const canceled = await client.cancelTask('task-id');
```

## Tools

### FunctionTool

```typescript
import { FunctionTool } from '@a2x/sdk';

const weatherTool = new FunctionTool({
  name: 'get_weather',
  description: 'Get weather for a location',
  parameters: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'City name' },
    },
    required: ['location'],
  },
  execute: async ({ location }) => {
    return { temp: 72, condition: 'sunny', location };
  },
});

const agent = new LlmAgent({
  name: 'weather_bot',
  description: 'Weather assistant',
  instruction: 'Use the get_weather tool to answer weather questions.',
  provider,
  tools: [weatherTool],
});
```

### AgentTool

Use another agent as a callable tool:

```typescript
import { AgentTool } from '@a2x/sdk';

const researchAgent = new LlmAgent({ /* ... */ });

const mainAgent = new LlmAgent({
  name: 'orchestrator',
  description: 'Orchestrates sub-agents',
  instruction: 'Delegate research tasks to the research agent.',
  provider,
  tools: [new AgentTool({ agent: researchAgent })],
});
```

## Agent Patterns

| Pattern | Description |
|---|---|
| `LlmAgent` | Single LLM-powered agent |
| `SequentialAgent` | Pipeline of agents executed in order |
| `ParallelAgent` | Agents executed concurrently |
| `LoopAgent` | Iterative refinement until exit condition |

## Authentication

```typescript
import { ApiKeyAuthorization, HttpBearerAuthorization } from '@a2x/sdk';

a2xAgent
  .addSecurityScheme('apiKey', new ApiKeyAuthorization({
    in: 'header',
    name: 'x-api-key',
    keys: ['your-secret-key'],
  }))
  .addSecurityScheme('bearer', new HttpBearerAuthorization({
    validator: async (token) => {
      const valid = token === process.env.AUTH_TOKEN;
      return { authenticated: valid };
    },
  }))
  // OR logic: either scheme satisfies auth
  .addSecurityRequirement({ apiKey: [] })
  .addSecurityRequirement({ bearer: [] });
```

Supported schemes: `ApiKeyAuthorization`, `HttpBearerAuthorization`, `OAuth2AuthorizationCodeAuthorization`, `OAuth2ClientCredentialsAuthorization`, `OAuth2DeviceCodeAuthorization`, `OpenIdConnectAuthorization`, `MutualTlsAuthorization`.

## x402 Payments

Gate agent calls behind on-chain cryptocurrency payments using the [a2a-x402 v0.2](https://github.com/google-agentic-commerce/a2a-x402) extension.

Install the optional peers:

```bash
npm install x402 viem
```

Server:

```typescript
import { X402PaymentExecutor, X402_EXTENSION_URI } from '@a2x/sdk/x402';

const executor = new X402PaymentExecutor(innerExecutor, {
  accepts: [{
    network: 'base-sepolia',
    amount: '10000',                                   // 0.01 USDC (6 decimals)
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // USDC on Base Sepolia
    payTo: process.env.MERCHANT_ADDRESS!,
  }],
});

const agent = new A2XAgent({ taskStore, executor })
  .addExtension({ uri: X402_EXTENSION_URI, required: true });
```

Client:

```typescript
import { A2XClient } from '@a2x/sdk/client';
import { X402Client } from '@a2x/sdk/x402';
import { privateKeyToAccount } from 'viem/accounts';

const x402 = new X402Client(new A2XClient(url), {
  signer: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
});
const task = await x402.sendMessage({ message: { role: 'user', parts: [{ text: '...' }] } });
```

Full guide: [docs/guides/advanced/x402-payments.md](./docs/guides/advanced/x402-payments.md).

## AgentCard Versions

a2x handles the structural differences between A2A protocol versions transparently:

```typescript
const cardV10 = a2xAgent.getAgentCard();       // v1.0 (default)
const cardV03 = a2xAgent.getAgentCard('0.3');   // v0.3
```

| Field | v0.3 | v1.0 |
|---|---|---|
| URL | `AgentCard.url` | `supportedInterfaces[].url` |
| Transport | `preferredTransport` | `supportedInterfaces[].protocolBinding` |
| Security | `security` + `securitySchemes` | `securityRequirements` + `securitySchemes` |

## Exports

| Path | Description |
|---|---|
| `@a2x/sdk` | Core SDK (agents, tools, runner, transport, types) |
| `@a2x/sdk/client` | `A2XClient` for calling remote A2A agents |
| `@a2x/sdk/auth` | `DeviceFlowClient` for OAuth 2.0 Device Code flow |
| `@a2x/sdk/anthropic` | `AnthropicProvider` |
| `@a2x/sdk/openai` | `OpenAIProvider` |
| `@a2x/sdk/google` | `GoogleProvider` |
| `@a2x/sdk/x402` | a2a-x402 v0.2 payments (server + client) |

## Requirements

- Node.js >= 20
- TypeScript >= 5.6 (recommended)

## Links

- [GitHub Repository](https://github.com/planetarium/a2x)
- [A2A Protocol Specification](https://a2a-protocol.org/)
- [Samples](https://github.com/planetarium/a2x/tree/main/samples)

## License

MIT
