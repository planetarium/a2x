# Core Concepts

`@a2x/sdk` is a layered architecture with four main layers.

---

## Architecture Layers

```
Layer 4: Transport        — DefaultRequestHandler, createSSEStream, toA2x
Layer 3: A2X Integration  — A2XAgent, AgentExecutor, TaskStore, AgentCard mappers
Layer 2: Agent Runtime    — LlmAgent, Tools, Runner, Session, Providers
Layer 1: Types & Security — A2A protocol types, SecurityScheme classes
```

---

## Key Classes

### LlmAgent

The core agent that uses an LLM provider to process messages. Supports tools, callbacks, and output schemas.

```typescript
import { LlmAgent } from '@a2x/sdk';

const agent = new LlmAgent({
  name: 'my-agent',
  description: 'A helpful agent.',
  provider: provider,      // GoogleProvider, AnthropicProvider, or OpenAIProvider
  instruction: 'You are a helpful assistant.',
  tools: [],               // FunctionTool instances
  maxLlmCalls: 25,         // Max LLM roundtrips per run (default: 25)
  outputSchema: undefined,  // JSON Schema for structured output
  // Callbacks:
  // beforeModelCallback, afterModelCallback, beforeToolCallback
});
```

The `instruction` field can also be a function for dynamic system prompts:

```typescript
instruction: (context) => `You are helping user ${context.session.userId}.`,
```

### InMemoryRunner

Executes agents within a session context. Manages message history and tool call loops.

```typescript
import { InMemoryRunner } from '@a2x/sdk';

const runner = new InMemoryRunner({
  agent,
  appName: 'my-app',   // Used as namespace for session storage
});
```

### AgentExecutor

Bridges the Runner with the A2A Task lifecycle. Converts agent events to A2A protocol events (status updates, artifacts).

```typescript
import { AgentExecutor, StreamingMode } from '@a2x/sdk';

const executor = new AgentExecutor({
  runner,
  runConfig: {
    streamingMode: StreamingMode.SSE,  // or StreamingMode.NONE
    maxLlmCalls: 25,
  },
});
```

**StreamingMode options:**
- `StreamingMode.SSE` — Returns an AsyncGenerator for `message/stream` requests
- `StreamingMode.NONE` — Always returns completed Task synchronously

### InMemoryTaskStore

Manages A2A Task state (create, get, update, cancel). In-memory by default.

```typescript
import { InMemoryTaskStore } from '@a2x/sdk';

const taskStore = new InMemoryTaskStore();
```

For production, implement the `TaskStore` interface with database backing:

```typescript
interface TaskStore {
  createTask(params: CreateTaskParams): Promise<Task>;
  getTask(id: string): Promise<Task | null>;
  updateTask(id: string, update: TaskUpdate): Promise<void>;
  cancelTask(id: string): Promise<void>;
}
```

### A2XAgent

The central integration class. Bridges agent runtime with A2A protocol. Auto-generates AgentCards for both v0.3 and v1.0 from a single definition.

```typescript
import { A2XAgent } from '@a2x/sdk';

const a2xAgent = new A2XAgent({
  taskStore,
  executor,
  protocolVersion: '1.0',  // Default protocol version: '0.3' | '1.0'
});
```

**Builder methods** (all chainable):

```typescript
a2xAgent
  .setName('My Agent')              // Override auto-extracted name
  .setDescription('Agent desc')     // Override auto-extracted description
  .setVersion('1.0.0')              // Agent version
  .setDefaultUrl('http://localhost:3000/a2a')  // Required: endpoint URL
  .setCapabilities({ streaming: true, pushNotifications: false })
  .addSkill({
    id: 'skill-id',
    name: 'Skill Name',
    description: 'What this skill does',
    tags: ['tag1', 'tag2'],
    examples: ['Example input'],
  })
  .addSecurityScheme('schemeName', securitySchemeInstance)
  .addSecurityRequirement({ schemeName: [] });
```

**Getting AgentCards:**

```typescript
const cardV10 = a2xAgent.getAgentCard();       // Default version
const cardV03 = a2xAgent.getAgentCard('0.3');   // Explicit v0.3
const cardV10 = a2xAgent.getAgentCard('1.0');   // Explicit v1.0
```

### DefaultRequestHandler

Framework-agnostic JSON-RPC handler. Routes A2A methods to the appropriate logic.

```typescript
import { DefaultRequestHandler } from '@a2x/sdk';

const handler = new DefaultRequestHandler(a2xAgent);

// Handle a JSON-RPC request
const result = await handler.handle(body, context);
// result: JSONRPCResponse | AsyncGenerator (for streaming)

// Get AgentCard
const card = handler.getAgentCard();          // Default version
const card = handler.getAgentCard('0.3');     // Specific version
```

**Supported A2A methods:**
- `message/send` — Send a message, get completed Task
- `message/stream` — Send a message, get streaming events (AsyncGenerator)
- `tasks/get` — Get a task by ID
- `tasks/cancel` — Cancel a running task

---

## Protocol Versions (v0.3 vs v1.0)

`@a2x/sdk` supports both A2A protocol versions from a single definition. The key differences are handled automatically by mappers:

| Aspect | v0.3 | v1.0 |
|--------|------|------|
| URL | `AgentCard.url` (top-level) | `supportedInterfaces[].url` |
| Transport | `preferredTransport` | `supportedInterfaces[].protocolBinding` |
| Security | `security[]` + `securitySchemes{}` | `securityRequirements[]` (OpenAPI 3.2) |
| Device Code OAuth | Not supported | Supported |

You define your agent once, and `A2XAgent.getAgentCard(version)` outputs the correct format.

---

## RequestContext

Framework-agnostic auth context passed to `handler.handle()`:

```typescript
import type { RequestContext } from '@a2x/sdk';

const context: RequestContext = {
  headers: { 'x-api-key': 'my-key', authorization: 'Bearer token' },
  query: { version: '1.0' },
  cookies: { session: 'abc' },
};

const result = await handler.handle(body, context);
```

Each framework extracts this differently — see the framework-specific guides.

---

## Task Lifecycle

```
SUBMITTED → WORKING → COMPLETED
                    → FAILED
                    → CANCELED
                    → INPUT_REQUIRED
                    → AUTH_REQUIRED
```

Tasks are created automatically when `message/send` or `message/stream` is called. The `AgentExecutor` manages state transitions.
