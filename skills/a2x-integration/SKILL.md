---
name: a2x-integration
description: Integrates the @a2x/sdk (A2A Agent-to-Agent protocol) into any TypeScript project. Supports Next.js App Router, Next.js Pages Router, Express, NestJS, and zero-framework quick start. Use when the user wants to add A2A agent capabilities using @a2x/sdk, or says things like "add a2x", "integrate a2x", "a2x agent", "a2x endpoint", "add a2a with a2x", "create an a2x agent".
---

# a2x-integration

Add A2A (Agent-to-Agent) protocol support to any TypeScript project using `@a2x/sdk`.

**`@a2x/sdk`** is a self-contained A2A SDK with zero runtime dependencies (only Node.js built-ins). It includes an agent runtime, LLM providers, authentication, task management, and HTTP transport — all in one package.

---

## Before You Start

**IMPORTANT**: The `@a2x/sdk` package evolves quickly. Before writing any code:

1. Install the package first (see Step 1).
2. Read actual type definitions from `node_modules/@a2x/sdk` to confirm current API signatures.
3. If a class, function, or import path referenced in this skill does not exist in the installed version, search `node_modules/@a2x/sdk` for the closest equivalent.
4. **Never hardcode package versions.** Always install the latest.

---

## Wiki Reference

This skill uses a wiki-style structure. Detailed reference material is in the `wiki/` directory:

| Topic | File | Description |
|-------|------|-------------|
| **Core Concepts** | [wiki/concepts.md](./wiki/concepts.md) | Architecture layers, key classes, protocol versions |
| **LLM Providers** | [wiki/providers.md](./wiki/providers.md) | Google, Anthropic, OpenAI provider setup |
| **Tools & Agents** | [wiki/tools-and-agents.md](./wiki/tools-and-agents.md) | FunctionTool, AgentTool, multi-agent patterns |
| **Security** | [wiki/security.md](./wiki/security.md) | API Key, Bearer, OAuth2, security requirements |
| **SSE Streaming** | [wiki/streaming.md](./wiki/streaming.md) | createSSEStream, AsyncGenerator, SSE headers |
| **Quick Start** | [wiki/quick-start.md](./wiki/quick-start.md) | `toA2x()` helper for zero-framework prototyping |

### Framework Guides

| Framework | File |
|-----------|------|
| **Next.js App Router** | [wiki/nextjs-app-router.md](./wiki/nextjs-app-router.md) |
| **Next.js Pages Router** | [wiki/nextjs-pages-router.md](./wiki/nextjs-pages-router.md) |
| **Express** | [wiki/express.md](./wiki/express.md) |
| **NestJS** | [wiki/nestjs.md](./wiki/nestjs.md) |

---

## Workflow

### Step 0 — Analyze the Existing Project

Before any implementation:

1. Read `package.json` to identify the HTTP framework, package manager, and existing dependencies.
2. Inspect `src/` (or project root) to understand the directory layout and conventions.
3. Determine the framework type:
   - **Next.js App Router** — `src/app/` or `app/` directory with `route.ts` files
   - **Next.js Pages Router** — `src/pages/` or `pages/` directory with `api/` folder
   - **Express** — `express` in dependencies, typically `app.ts` or `server.ts`
   - **NestJS** — `@nestjs/core` in dependencies, module/controller/service pattern
   - **None / Quick prototype** — No HTTP framework, or user wants minimal setup
4. Check for an existing `.env.example` or `.env` file to understand environment variable conventions.
5. Identify which LLM provider the user wants (Google Gemini, Anthropic Claude, OpenAI GPT). If unclear, ask the user.

---

### Step 1 — Install Packages

```bash
# Use the project's package manager (npm, pnpm, yarn, bun)
npm install @a2x/sdk
```

Install the LLM provider SDK as a peer dependency based on user choice:

```bash
# For Google Gemini
npm install @google/genai

# For Anthropic Claude
npm install @anthropic-ai/sdk

# For OpenAI GPT
npm install openai
```

After installation, verify key exports exist:

```bash
grep -r "export" node_modules/@a2x/sdk/dist/index.d.ts 2>/dev/null | head -30
```

Look for these key exports:

| Export | Purpose |
|--------|---------|
| `LlmAgent` | Agent with LLM provider and tools |
| `InMemoryRunner` | Agent execution runtime |
| `AgentExecutor` | Bridges runner with A2A task lifecycle |
| `InMemoryTaskStore` | In-memory task storage |
| `A2XAgent` | A2A protocol integration (AgentCard, skills, security) |
| `DefaultRequestHandler` | Framework-agnostic JSON-RPC handler |
| `createSSEStream` | SSE streaming helper |
| `FunctionTool` | Wrap async functions as tools |

---

### Step 2 — Set Up Environment Variables

Create or update `.env.example`:

```env
# LLM Provider API Key (choose one based on your provider)
GOOGLE_API_KEY=
# ANTHROPIC_API_KEY=
# OPENAI_API_KEY=

# Public base URL of this server (used in AgentCard)
BASE_URL=http://localhost:3000

# Optional: Security
# API_KEYS=key1,key2,key3
```

Ensure `.env.local` (or `.env`) is in `.gitignore`.

---

### Step 3 — Create the A2X Setup Module

This is the core integration. Create an a2x setup file (e.g., `lib/a2x-setup.ts`, `src/lib/a2x-setup.ts`, or wherever the project keeps shared modules).

Read [wiki/concepts.md](./wiki/concepts.md) for the full architecture, then create the setup:

```typescript
import {
  LlmAgent,
  InMemoryRunner,
  AgentExecutor,
  StreamingMode,
  InMemoryTaskStore,
  A2XAgent,
  DefaultRequestHandler,
} from '@a2x/sdk';
// Choose your provider — see wiki/providers.md
import { GoogleProvider } from '@a2x/sdk/google';
// import { AnthropicProvider } from '@a2x/sdk/anthropic';
// import { OpenAIProvider } from '@a2x/sdk/openai';

// 1. Define the LLM agent
const agent = new LlmAgent({
  name: 'my-agent',
  description: 'A helpful AI agent.',
  provider: new GoogleProvider({
    model: 'gemini-2.5-flash',
    apiKey: process.env.GOOGLE_API_KEY!,
  }),
  instruction: 'You are a helpful assistant. Answer clearly and concisely.',
  // tools: [],  // Add FunctionTools here — see wiki/tools-and-agents.md
});

// 2. Create the runtime
const runner = new InMemoryRunner({ agent, appName: agent.name });
const executor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
});
const taskStore = new InMemoryTaskStore();

// 3. Create the A2XAgent (A2A protocol bridge)
export const a2xAgent = new A2XAgent({ taskStore, executor, protocolVersion: '1.0' })
  .setDefaultUrl(`${process.env.BASE_URL ?? 'http://localhost:3000'}/a2a`)
  .addSkill({
    id: 'chat',
    name: 'General Chat',
    description: 'General-purpose conversation and Q&A',
    tags: ['chat', 'general'],
  });
// Add security — see wiki/security.md
// .addSecurityScheme('apiKey', new ApiKeyAuthorization({ ... }))
// .addSecurityRequirement({ apiKey: [] })

// 4. Create the request handler
export const handler = new DefaultRequestHandler(a2xAgent);
```

**Customization points for the user:**
- `name` / `description` — agent identity
- `provider` — which LLM to use (see [wiki/providers.md](./wiki/providers.md))
- `instruction` — system prompt that defines agent behavior
- `tools` — array of tools (see [wiki/tools-and-agents.md](./wiki/tools-and-agents.md))
- `skills` — A2A skills advertised in the AgentCard
- Security — authentication schemes (see [wiki/security.md](./wiki/security.md))

---

### Step 4 — Implement Route Handlers

Choose the framework guide matching the project:

- **Next.js App Router** → [wiki/nextjs-app-router.md](./wiki/nextjs-app-router.md)
- **Next.js Pages Router** → [wiki/nextjs-pages-router.md](./wiki/nextjs-pages-router.md)
- **Express** → [wiki/express.md](./wiki/express.md)
- **NestJS** → [wiki/nestjs.md](./wiki/nestjs.md)
- **Quick prototype (no framework)** → [wiki/quick-start.md](./wiki/quick-start.md)

Each guide provides:
1. Agent Card endpoint (`GET /.well-known/agent.json`)
2. JSON-RPC endpoint (`POST /a2a`)
3. SSE streaming setup
4. Framework-specific notes

The core logic is framework-agnostic (see [wiki/streaming.md](./wiki/streaming.md)):

```typescript
const result = await handler.handle(body, context);

if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
  // Streaming: AsyncGenerator → convert to SSE response
} else {
  // Synchronous: plain object → return as JSON
}
```

---

### Step 5 — Verify

1. **Build check**: Run the project's build command to ensure no type errors.
2. **Agent Card**: `curl http://localhost:<port>/.well-known/agent.json` — should return valid JSON with `name`, `url`, `skills`, `capabilities`.
3. **Send message**:
   ```bash
   curl -X POST http://localhost:<port>/a2a \
     -H "Content-Type: application/json" \
     -d '{"jsonrpc":"2.0","id":1,"method":"message/send","params":{"message":{"role":"user","parts":[{"kind":"text","text":"Hello"}]}}}'
   ```
4. Remind the user to set their LLM provider API key if not already done.
5. Optionally test with `a2x` CLI:
   ```bash
   a2x a2a agent-card http://localhost:<port>
   a2x a2a send http://localhost:<port> "Hello, agent!"
   ```

---

## Exposed Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/agent.json` | GET | AgentCard discovery (A2A standard) |
| `/a2a` | POST | JSON-RPC 2.0 endpoint for A2A messages |

The paths can be customized — update `setDefaultUrl()` on the A2XAgent to match.

---

## Key Differences from `ts-a2a-integration` Skill

This skill uses `@a2x/sdk` instead of `@a2a-js/sdk` + `@google/adk`. Key differences:

| Feature | `@a2x/sdk` | `@a2a-js/sdk` + `@google/adk` |
|---------|-----------|-------------------------------|
| Dependencies | Single package | Two packages |
| LLM Providers | Google, Anthropic, OpenAI built-in | Google only (via ADK) |
| Protocol Versions | v0.3 + v1.0 from single definition | v1.0 only |
| AgentCard | Auto-generated via `A2XAgent` builder | Manual JSON object |
| Authentication | Built-in security scheme classes | Manual implementation |
| Handler | `DefaultRequestHandler` (framework-agnostic) | `JsonRpcTransportHandler` |
| Quick Start | `toA2x()` helper with built-in HTTP server | Not available |

---

## After Applying

Remind the user to:
1. Set their LLM provider API key in the environment
2. Customize the agent: name, description, instruction (system prompt), and skills
3. Add tools if needed (see [wiki/tools-and-agents.md](./wiki/tools-and-agents.md))
4. Configure security if needed (see [wiki/security.md](./wiki/security.md))
5. Test with `curl` or the `a2x` CLI
