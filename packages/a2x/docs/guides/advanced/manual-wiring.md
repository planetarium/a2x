# Manual Wiring

`toA2x()` is a convenience wrapper. Underneath, it composes five pieces: the agent, a **runner**, an **executor**, a **task store**, and an **A2XAgent** that binds everything to a **request handler**. This guide unpacks that stack so you can customize any of it.

Reach for manual wiring when you need to:

- Mount A2X into an existing HTTP stack (Express, Next.js, etc.). → See also [Framework Integration](../agent/framework-integration.md).
- Swap the in-memory task store for Redis or Postgres.
- Customize the AgentCard beyond what `toA2x()` auto-extracts.
- Add A2A skills, security schemes, or extensions.

## The full stack

```ts
import {
  LlmAgent,
  InMemoryRunner,
  AgentExecutor,
  StreamingMode,
  InMemoryTaskStore,
  A2XAgent,
  DefaultRequestHandler,
} from '@a2x/sdk';
import { GoogleProvider } from '@a2x/sdk/google';

// 1. The agent — what actually runs when a message arrives.
const agent = new LlmAgent({
  name: 'my_agent',
  description: 'My A2A agent.',
  instruction: 'You are a helpful assistant.',
  provider: new GoogleProvider({
    model: 'gemini-2.5-flash',
    apiKey: process.env.GOOGLE_API_KEY!,
  }),
});

// 2. Runner — drives the agent loop (tool calls, multi-turn, etc.).
const runner = new InMemoryRunner({ agent, appName: agent.name });

// 3. Executor — adapts the runner into the task/streaming model A2A expects.
const executor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
});

// 4. Task store — persists task state across calls (getTask, cancelTask).
const taskStore = new InMemoryTaskStore();

// 5. A2XAgent — emits the AgentCard and owns skills, security, versioning.
const a2xAgent = new A2XAgent({ taskStore, executor })
  .setDefaultUrl('https://my-agent.example.com/a2a')
  .addSkill({
    id: 'chat',
    name: 'Chat',
    description: 'General conversation.',
    tags: ['chat'],
  });

// 6. Request handler — the thing your HTTP layer calls.
const handler = new DefaultRequestHandler(a2xAgent);
```

`handler.getAgentCard()` returns the AgentCard JSON. `handler.handle(body, context)` processes a JSON-RPC request and returns either a plain object or an async iterable (for streams).

## Customizing each piece

### Runner

`InMemoryRunner` is the default. It keeps session state in memory per agent instance — fine for single-process deployments and stateless serverless functions. Swap it if you need shared state across workers.

### Executor / streaming mode

- `StreamingMode.SSE` — incremental Server-Sent Events (default, recommended).
- omit it — unary responses only.

### Task store

`InMemoryTaskStore` is the default. It loses state on restart, which is fine for stateless deployments but not for production long-running tasks. See [Custom Task Stores](./task-store.md).

### Task event bus

The bus fans `message/stream` events out to any `tasks/resubscribe` subscribers. `A2XAgent` creates a default `InMemoryTaskEventBus` when you don't pass one — sufficient for single-process deployments.

Swap it when you need cross-process fan-out (e.g. multiple worker nodes behind a load balancer):

```ts
import { A2XAgent, type TaskEventBus } from '@a2x/sdk';

class RedisTaskEventBus implements TaskEventBus {
  publish(taskId, event) { /* PUBLISH a2x:task:<taskId> */ }
  close(taskId) { /* PUBLISH a2x:task:<taskId>:close */ }
  async *subscribe(taskId, signal) { /* SUBSCRIBE + yield until close */ }
  hasSubscribers(taskId) { /* SUBSCRIBERS count */ }
}

const a2xAgent = new A2XAgent({
  taskStore,
  executor,
  taskEventBus: new RedisTaskEventBus(),
});
```

The default implementation's queue is unbounded — fine for most agents, but consider bounded backpressure if a single task can emit thousands of events faster than slow subscribers can drain.

### AgentCard skills and metadata

```ts
a2xAgent
  .setDefaultUrl('https://my-agent.example.com/a2a')
  .setIconUrl('https://my-agent.example.com/icon.png')
  .addSkill({
    id: 'weather',
    name: 'Weather lookup',
    description: 'Returns current weather for a city.',
    tags: ['weather', 'tools'],
  })
  .addSkill({
    id: 'summarize',
    name: 'Summarize text',
    description: 'Produces a 1-paragraph summary.',
    tags: ['text'],
  });
```

Skills are how other agents and directories understand what yours does. Prefer descriptive, stable IDs — they're part of your public contract.

### Security schemes

```ts
import { ApiKeyAuthorization } from '@a2x/sdk';

a2xAgent
  .addSecurityScheme('apiKey', new ApiKeyAuthorization({
    in: 'header',
    name: 'x-api-key',
    keys: [process.env.API_KEY!],
  }))
  .addSecurityRequirement({ apiKey: [] });
```

See [Authentication](./authentication.md) for all available schemes.

### Capabilities

Most capability flags on the AgentCard are derived automatically:

- `capabilities.streaming` is taken from `runConfig.streamingMode`.
- `capabilities.pushNotifications` is `true` when the constructor receives a
  `pushNotificationConfigStore`, `false` otherwise.
- `capabilities.extendedAgentCard` is set when
  `setAuthenticatedExtendedCardProvider()` is called.

Two capabilities need explicit builder calls — both are append-only / boolean:

```ts
import { X402_EXTENSION_URI } from '@a2x/sdk/x402';

a2xAgent
  .addExtension({ uri: X402_EXTENSION_URI, required: true })
  // or: .addExtension('https://example.com/ext', { required: true })
  .setStateTransitionHistory(true); // v0.3 only; dropped on v1.0 cards
```

`setPushNotifications(false)` exists for the rare case where the store is
wired but you want to hide the capability.

> `setCapabilities(...)` is deprecated in favor of the focused methods above
> and will be removed in the next major. While it coexists, the `extensions`
> field is treated as append-only so multi-source callers no longer clobber
> each other.

## Serving the handler

Once you have `handler`, mount it in any HTTP framework. The recipe is in [Framework Integration](../agent/framework-integration.md).

## When `toA2x()` is enough

If you don't need any of the customizations above, don't bother with manual wiring. `toA2x()` produces the same handler internally and exposes it if you need to reach back in:

```ts
const app = toA2x(agent, { port: 4000, defaultUrl: '...' });
// app gives you the running server; access .handler if you need it.
```
