# a2x

[![npm version](https://img.shields.io/npm/v/@a2x/sdk.svg)](https://www.npmjs.com/package/@a2x/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A self-contained TypeScript SDK for building [A2A (Agent-to-Agent)](https://google.github.io/A2A/) protocol agents with integrated OAuth 2.0 Device Flow authentication.

## Why a2x?

Existing A2A libraries like Google ADK (`@google/adk`) and `@a2a-js/sdk` have fundamental limitations:

- **Protocol update lag** — A2A v1.0 is already released, but ADK still only supports v0.3. You're blocked until upstream catches up.
- **Raw AgentCard authoring** — You must know the full A2A schema (required fields, nested structures, security config) and hand-write JSON. High learning curve, easy to get wrong.
- **Breaking changes across versions** — v0.3 AgentCards are structurally incompatible with v1.0 (e.g., `url` moved from top-level to `supportedInterfaces[].url`). Upgrading means rewriting your AgentCard from scratch.

a2x solves all three. Define your agent once, and a2x generates spec-compliant AgentCards for any protocol version — automatically.

## Installation

```bash
# SDK
npm install @a2x/sdk

# CLI (via GitHub Releases)
# Download the latest tarball from https://github.com/planetarium/a2x/releases
```

## Key Features

- **Auto-extraction** — `A2XAgent` infers AgentCard fields (`name`, `description`, `capabilities.streaming`) from your runtime objects. No manual duplication.
- **Multi-version AgentCard** — Generate v0.3 and v1.0 AgentCards from the same `A2XAgent` instance with `getAgentCard('0.3')` / `getAgentCard('1.0')`.
- **Builder pattern** — Override any auto-extracted value with chainable methods (`setName()`, `addSkill()`, `addSecurityScheme()`, etc.).
- **ADK-compatible patterns** — Familiar `LlmAgent`, `SequentialAgent`, `ParallelAgent`, `LoopAgent`, `FunctionTool`, `AgentTool`, `Runner`, and `Session` APIs.
- **Client SDK** — `A2XClient` for interacting with any A2A-compliant agent, with built-in auth scheme support.
- **Device Flow auth** — Built-in OAuth 2.0 Device Authorization Grant (RFC 8628) for CLI and browserless environments.
- **Framework-agnostic** — Works with Express, Fastify, Hono, Next.js, or any HTTP framework.
- **SSE streaming** — First-class support for `message/stream` via Server-Sent Events.
- **Zero runtime dependencies** — Core module uses only Node.js built-in APIs.
- **TypeScript-first** — Full type safety with types derived directly from A2A JSON Schema and proto definitions.

## Quick Start

```typescript
import {
  LlmAgent,
  A2XAgent,
  AgentExecutor,
  InMemoryRunner,
  InMemoryTaskStore,
  DefaultRequestHandler,
  StreamingMode,
} from '@a2x/sdk';
import { GoogleProvider } from '@a2x/sdk/google';

// 1. Define your agent
const agent = new LlmAgent({
  name: 'my_assistant',
  provider: new GoogleProvider({ model: 'gemini-2.5-flash', apiKey: process.env.GOOGLE_API_KEY! }),
  description: 'A helpful assistant.',
  instruction: 'You are a helpful assistant.',
});

// 2. Set up the runtime
const runner = new InMemoryRunner({ agent, appName: 'my_app' });
const executor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
});
const taskStore = new InMemoryTaskStore();

// 3. Create A2XAgent — name, description, and streaming are auto-extracted
const a2xAgent = new A2XAgent({ taskStore, executor })
  .setDefaultUrl('https://my-agent.example.com/a2a')
  .addSkill({
    id: 'chat',
    name: 'Chat',
    description: 'General conversation',
    tags: ['chat'],
  });

// 4. Wire up the request handler
const handler = new DefaultRequestHandler(a2xAgent);

// 5. Get AgentCards for any protocol version
const cardV10 = a2xAgent.getAgentCard();        // v1.0 (default)
const cardV03 = a2xAgent.getAgentCard('0.3');    // v0.3
```

## How It Works

```
A2XAgent
├── taskStore (InMemoryTaskStore, etc.)
└── agentExecutor
    ├── runner
    │   └── agent (LlmAgent)
    │       ├── name         → AgentCard.name (auto-extracted)
    │       └── description  → AgentCard.description (auto-extracted)
    └── runConfig
        └── streamingMode    → capabilities.streaming (auto-extracted)

getAgentCard(version?)
├── "0.3" → v0.3 Mapper → AgentCard (v0.3 JSON)
└── "1.0" → v1.0 Mapper → AgentCard (v1.0 JSON)
```

**Value resolution priority:**
1. Explicit override (builder methods) — highest
2. Auto-extraction from runtime objects
3. Protocol version defaults — lowest

## Agent Patterns

| Pattern | Description | Use Case |
|---|---|---|
| `LlmAgent` | Single LLM-powered agent | Q&A bots, summarization, translation |
| `SequentialAgent` | Pipeline of agents executed in order | Research → Write, Analyze → Act |
| `ParallelAgent` | Agents executed concurrently | Multi-faceted analysis, A/B responses |
| `LoopAgent` | Iterative refinement until exit condition | Self-improvement loops, validation |

## Tool Patterns

| Pattern | Description |
|---|---|
| `FunctionTool` | Wrap any async function as an agent tool (with Zod schema) |
| `AgentTool` | Use another agent as a callable tool |

## Client SDK

```typescript
import { A2XClient, resolveAgentCard } from '@a2x/sdk/client';

// Discover an agent
const card = await resolveAgentCard('https://agent.example.com');

// Create a client and send messages
const client = new A2XClient(card);
const task = await client.sendMessage({
  message: { role: 'user', parts: [{ text: 'Hello!' }] },
});

// Or stream responses
for await (const event of client.sendMessageStream({
  message: { role: 'user', parts: [{ text: 'Tell me a story' }] },
})) {
  console.log(event);
}
```

## Server Integration

**Quick prototype** with `toA2x()`:

```typescript
import { LlmAgent, toA2x } from '@a2x/sdk';
import { GoogleProvider } from '@a2x/sdk/google';

const agent = new LlmAgent({
  name: 'quick_agent',
  provider: new GoogleProvider({ model: 'gemini-2.5-flash', apiKey: process.env.GOOGLE_API_KEY! }),
  description: 'A quick prototype agent.',
  instruction: 'You are a helpful assistant.',
});

const app = toA2x(agent, {
  port: 4000,
  defaultUrl: 'http://localhost:4000/a2a',
});
```

**Manual wiring** for any HTTP framework (Next.js example):

```typescript
export async function POST(request: Request) {
  const body = await request.json();
  return handler.handle(body);
}

export async function GET() {
  return Response.json(a2xAgent.getAgentCard());
}
```

## Device Flow Authentication

```typescript
import { DeviceFlowClient } from '@a2x/sdk/auth';

const authClient = new DeviceFlowClient({
  agentCardUrl: 'https://my-agent.example.com/.well-known/agent.json',
});

const { userCode, verificationUri } = await authClient.requestDeviceCode({ scope: 'read write' });
console.log(`Visit ${verificationUri} and enter code: ${userCode}`);

const token = await authClient.pollForToken(deviceCode);
const a2aClient = authClient.createAuthenticatedClient(token);
```

## CLI

The `@a2x/cli` provides command-line tools for interacting with A2A agents.

```bash
# Send a message to an agent
a2x a2a send <agent-url> "Hello, agent!"

# Stream a response
a2x a2a stream <agent-url> "Tell me a story"

# Fetch an agent card
a2x a2a agent-card <agent-url>

# Check task status
a2x a2a task <agent-url> <task-id>
```

Install from [GitHub Releases](https://github.com/planetarium/a2x/releases) or build from source:

```bash
git clone https://github.com/planetarium/a2x.git
cd a2x
pnpm install && pnpm build
pnpm cli:install
```

## A2A Protocol Versions

a2x handles the structural differences between A2A v0.3 and v1.0 transparently:

| Field | v0.3 | v1.0 |
|---|---|---|
| URL | `AgentCard.url` (top-level) | `supportedInterfaces[].url` |
| Transport | `preferredTransport` | `supportedInterfaces[].protocolBinding` |
| Protocol version | `AgentCard.protocolVersion` | `supportedInterfaces[].protocolVersion` |
| Security | `security` + `securitySchemes` | `securityRequirements` + `securitySchemes` (OpenAPI 3.2) |
| Multi-tenant | Not supported | `supportedInterfaces[].tenant` |
| Signatures | Not supported | `signatures[]` (JWS) |

## Tech Stack

- **Language**: TypeScript 5.x
- **Runtime**: Node.js 20+
- **Module**: ESM (tree-shakeable)
- **Build**: tsup (ESM + CJS dual emit)
- **Package manager**: pnpm (workspace)
- **Test**: vitest
- **Versioning**: changesets (independent per package)
- **CI/CD**: GitHub Actions

## License

MIT
