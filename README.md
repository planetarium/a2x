# a2x

[![CI](https://github.com/planetarium/a2x/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/planetarium/a2x/actions/workflows/ci.yml)
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

The optional x402 integration requires `@x402/core` and `@x402/evm`
`>=2.20.0 <3`.

## Key Features

- **Auto-extraction** — `A2XServer` infers AgentCard fields (`name`, `description`, `capabilities.streaming`) from your runtime objects. No manual duplication.
- **Multi-version AgentCard** — Speak A2A v0.3 or v1.0 by constructing `new A2XServer({ ..., protocolVersion: '0.3' | '1.0' })`. Card and wire stay consistent for the chosen version; a v1.0 server accepts the v1.0 JSON-RPC method names (`SendMessage`, `GetTask`, …), the `A2A-Extensions` header, and `A2A-Version` pinning, while still serving v0.3-speaking clients.
- **Builder pattern** — Override any auto-extracted value with chainable methods (`setName()`, `addSkill()`, `addSecurityScheme()`, etc.).
- **ADK-compatible patterns** — Familiar `LlmAgent`, `SequentialAgent`, `ParallelAgent`, `LoopAgent`, `FunctionTool`, `AgentTool`, `Runner`, and `Session` APIs.
- **Client SDK** — `A2XClient` for interacting with any A2A-compliant agent, with built-in auth scheme support.
- **JSON-RPC and HTTP+JSON transports** — Serve and consume both standard v1.0 HTTP bindings, including REST task listing, push-config CRUD, authenticated extended cards, and SSE streams. AgentCard selection is deterministic and fails closed for unsupported bindings.
- **Device Flow auth** — Built-in OAuth 2.0 Device Authorization Grant (RFC 8628) for CLI and browserless environments.
- **Framework-agnostic** — Works with Express, Fastify, Hono, Next.js, or any HTTP framework.
- **SSE streaming** — First-class support for `message/stream` via Server-Sent Events.
- **Multi-modal artifacts** — Agents can yield `text`, `file`, and `data` `AgentEvent`s; the default executor maps each to a `TextPart` / `FilePart` / `DataPart` artifact on the wire.
- **x402 payments** — Charge per call with on-chain cryptocurrency payments — declared inline in `agent.run()` via the `request-input` AgentEvent. Optional `@a2x/sdk/x402` subpath. Supports both x402 protocol versions (legacy V1 and the [x402 Foundation](https://github.com/x402-foundation/x402) V2 transport) — each deployment speaks one, V1 by default, V2 via `new X402Context({ x402Version: 2 })`.
- **Shared x402 merchant policy** — Optional [`MerchantGate`](./packages/a2x/docs/guides/advanced/x402-payments.md#shared-merchant-policy-gate) from `@a2x/sdk/x402` for hosts that want reusable exact, `upto`, and `batch-settlement` pricing, metering, frozen offer terms, lifecycle-aware replay protection, and explicit buffered or progressive delivery timing without coupling the SDK to `AgentEvent`s or hard-coded rates.
- **Usage-based payments** — Native support for the x402 V2 `upto` scheme: the payer signs a Permit2 authorization up to a maximum, the agent meters the work and settles only the actual charge via `settle(ctx, classified, { amountAtomic })`, clamped SDK-side so a metering bug can never overcharge. Bill by LLM tokens instead of a flat fee.
- **Conversation-scoped payments** — `UptoSessionManager` holds one `upto` authorization across an A2A context, accumulates trusted usage over concurrent turns, and settles once on idle, deadline, budget, or host shutdown. CAS-backed opening reservations and turn leases claim each turn before resource work starts, preventing duplicate settlement and unmetered race losers.
- **Batched payments** — Native payer and merchant support for the x402 V2 `batch-settlement` scheme: fund an on-chain channel once, then pay per call with an off-chain voucher. Merchant verification, reservation cancellation, metered commit, refund bypass, and recovery receipts run through the official x402 resource-server lifecycle.
- **Zero runtime dependencies** — Core module uses only Node.js built-in APIs.
- **TypeScript-first** — Full type safety with types derived directly from A2A JSON Schema and proto definitions.

## Quick Start

```typescript
import {
  LlmAgent,
  A2XServer,
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

// 3. Create A2XServer — name, description, and streaming are auto-extracted
const a2xServer = new A2XServer({ taskStore, executor })
  .setDefaultUrl('https://my-agent.example.com/a2a')
  .addSkill({
    id: 'chat',
    name: 'Chat',
    description: 'General conversation',
    tags: ['chat'],
  });

// 4. Wire up the request handler
const handler = new DefaultRequestHandler(a2xServer);

// 5. Render the AgentCard in the configured wire format
const card = a2xServer.getAgentCard();
//   To serve v0.3 instead, construct with `protocolVersion: '0.3'`.
```

## How It Works

```
A2XServer
├── taskStore (InMemoryTaskStore, etc.)
└── agentExecutor
    ├── runner
    │   └── agent (LlmAgent)
    │       ├── name         → AgentCard.name (auto-extracted)
    │       └── description  → AgentCard.description (auto-extracted)
    └── runConfig
        └── streamingMode    → capabilities.streaming (auto-extracted)

getAgentCard()
└── A2XServer.protocolVersion → matching mapper → AgentCard JSON
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
import { A2XClient } from '@a2x/sdk/client';

// The client discovers the agent card from /.well-known/agent.json
const client = new A2XClient('https://agent.example.com');

// Send messages
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
import { A2A_TRANSPORTS, LlmAgent, toA2x } from '@a2x/sdk';
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
  // Defaults to JSONRPC only. Add HTTP_JSON to expose the v1.0 REST routes.
  transports: [A2A_TRANSPORTS.JSONRPC, A2A_TRANSPORTS.HTTP_JSON],
});
```

**Manual wiring** for any HTTP framework (Next.js example):

```typescript
export async function POST(request: Request) {
  const body = await request.json();
  return handler.handle(body);
}

export async function GET() {
  return Response.json(a2xServer.getAgentCard());
}
```

## Device Flow Authentication

Plug an `AuthProvider` into `A2XClient`. The SDK hands you the auth schemes
declared on the agent card (including `OAuth2DeviceCodeAuthScheme`) and you
populate them via `scheme.setCredential(...)`:

```typescript
import { A2XClient, OAuth2DeviceCodeAuthScheme } from '@a2x/sdk/client';
import type { AuthProvider } from '@a2x/sdk/client';

const authProvider: AuthProvider = {
  async provide(requirements) {
    // requirements: AuthScheme[][] — OR of ANDs. Pick any satisfiable group.
    const group = requirements[0];
    for (const scheme of group) {
      if (scheme instanceof OAuth2DeviceCodeAuthScheme) {
        // Run the RFC 8628 poll loop against scheme.params.deviceAuthorizationUrl
        // and scheme.params.tokenUrl, then call setCredential with the token.
        scheme.setCredential(await runDeviceCodeFlow(scheme));
      }
    }
    return group;
  },
};

const client = new A2XClient('https://agent.example.com', { authProvider });
```

For a working RFC 8628 flow (display user code, poll token endpoint, persist tokens),
see `packages/cli/src/cli-auth-provider.ts` in the `@a2x/cli` package.

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

# Upgrade to the latest release
a2x update
```

Install from [GitHub Releases](https://github.com/planetarium/a2x/releases) or build from source:

```bash
git clone https://github.com/planetarium/a2x.git
cd a2x
pnpm install && pnpm build
pnpm cli:install
```

`a2x update` resolves the newest `cli-v*` release, verifies the downloaded
asset against the SHA-256 GitHub publishes for it, and then replaces the
standalone binary in place (or reinstalls the npm tarball, depending on how
`a2x` was installed). Use `a2x update --check` to report an available version
without installing it.

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
- **Runtime**: Node.js 22.11+
- **Module**: ESM (tree-shakeable)
- **Build**: tsup (ESM + CJS dual emit)
- **Package manager**: pnpm (workspace)
- **Test**: vitest
- **Versioning**: changesets (independent per package)
- **CI/CD**: GitHub Actions

## Contact

Maintained by [Planetarium](https://github.com/planetarium). For questions, bug reports, and community inquiries:

- GitHub Issues — https://github.com/planetarium/a2x/issues
- Email — a2x@planetariumhq.com
- Website — https://a2x.sh

## License

MIT
