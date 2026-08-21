# Manual Wiring

`toA2x()` is a convenience wrapper. Underneath, it composes five pieces: the agent, a **runner**, an **executor**, a **task store**, and an **A2XServer** that binds everything to a **request handler**. This guide unpacks that stack so you can customize any of it.

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
  A2XServer,
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

// 5. A2XServer — emits the AgentCard and owns skills, security, versioning.
const a2xServer = new A2XServer({ taskStore, executor })
  .setDefaultUrl('https://my-agent.example.com/a2a')
  .addSkill({
    id: 'chat',
    name: 'Chat',
    description: 'General conversation.',
    tags: ['chat'],
  });

// 6. Transport-neutral domain handler plus JSON-RPC adapter.
const handler = new DefaultRequestHandler(a2xServer);
```

`handler.getAgentCard()` returns the AgentCard JSON. `handler.handle(body, context)` processes a JSON-RPC request and returns either a plain object or an async iterable (for streams). `handler.handleOperation()` is the transport-neutral boundary used by protocol adapters; most applications should mount an adapter rather than call it directly.

### HTTP+JSON transport

The v1.0 HTTP+JSON binding uses REST resources and `application/a2a+json` instead of JSON-RPC envelopes:

```ts
import {
  A2A_TRANSPORTS,
  HttpJsonRequestHandler,
} from '@a2x/sdk';

a2xServer.setDefaultTransport(A2A_TRANSPORTS.HTTP_JSON);

const httpJsonHandler = new HttpJsonRequestHandler(handler, {
  basePath: '/a2a',
});
```

Call `httpJsonHandler.handle({ method, url, body, context })` from your framework route. The result contains an HTTP `status`, response `headers`, and either a JSON `body` or an async generator for SSE. `HttpJsonRequestHandler` covers the complete A2A v1.0 REST operation surface and returns structured `google.rpc.Status` JSON errors.

Changing AgentCard metadata alone does not mount routes. Construct and mount `HttpJsonRequestHandler` whenever you advertise `HTTP+JSON`. Conversely, do not add an `HTTP+JSON` interface with `addInterface()` unless that URL is actually backed by the handler.

## Customizing each piece

### Runner

`InMemoryRunner` is the default. It keeps session state in memory per agent instance — fine for single-process deployments and stateless serverless functions. Swap it if you need shared state across workers.

### Executor / streaming mode

- `StreamingMode.SSE` — incremental Server-Sent Events (default, recommended).
- omit it — unary responses only.

### Task store

`InMemoryTaskStore` is the default. It loses state on restart, which is fine for stateless deployments but not for production long-running tasks. See [Custom Task Stores](./task-store.md).

### Task event bus

The bus fans `message/stream` events out to any `tasks/resubscribe` subscribers. `A2XServer` creates a default `InMemoryTaskEventBus` when you don't pass one — sufficient for single-process deployments.

Swap it when you need cross-process fan-out (e.g. multiple worker nodes behind a load balancer):

```ts
import { A2XServer, type TaskEventBus } from '@a2x/sdk';

class RedisTaskEventBus implements TaskEventBus {
  publish(taskId, event) { /* PUBLISH a2x:task:<taskId> */ }
  close(taskId) { /* PUBLISH a2x:task:<taskId>:close */ }
  async *subscribe(taskId, signal) { /* SUBSCRIBE + yield until close */ }
  hasSubscribers(taskId) { /* SUBSCRIBERS count */ }
}

const a2xServer = new A2XServer({
  taskStore,
  executor,
  taskEventBus: new RedisTaskEventBus(),
});
```

The default implementation's queue is unbounded — fine for most agents, but consider bounded backpressure if a single task can emit thousands of events faster than slow subscribers can drain.

### AgentCard skills and metadata

```ts
a2xServer
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

a2xServer
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
import { X402_FOUNDATION_EXTENSION_URI } from '@a2x/sdk/x402';

a2xServer
  .addExtension({ uri: X402_FOUNDATION_EXTENSION_URI, required: true })
  // or: .addExtension('https://example.com/ext', { required: true })
  .setStateTransitionHistory(true); // v0.3 only; dropped on v1.0 cards
```

`setPushNotifications(false)` exists for the rare case where the store is
wired but you want to hide the capability.

> `setCapabilities(...)` is deprecated in favor of the focused methods above
> and will be removed in the next major. While it coexists, the `extensions`
> field is treated as append-only so multi-source callers no longer clobber
> each other.

### Reading activated extensions

The extension URIs the client activated via the `X-A2A-Extensions` (v0.3) or
`A2A-Extensions` (v1.0) header are
threaded onto `InvocationContext.activatedExtensions`, so an agent can branch
on what the client activated:

```ts
async *run(ctx: InvocationContext) {
  if (ctx.activatedExtensions?.includes(X402_FOUNDATION_EXTENSION_URI)) {
    // client activated x402 — note this says nothing about the version:
    // the foundation URI is version-neutral. The only version signal
    // the channel carries is the legacy v0.2 URI, which declares a V1-only
    // client.
  }
}
```

When you drive `X402Context` yourself, forward the activated set into
`requestPayment` — an `x402Version: 2` context uses it to refuse a V1-only
(v0.2-activated) client with a clean `invalid_x402_version` failure instead of
emitting envelopes it cannot decode:

```ts
yield* x402.requestPayment(
  { taskId: ctx.taskId, activatedExtensions: ctx.activatedExtensions },
  { accepts },
);
```

`new X402Context({ x402Version })` sets the single wire version the server
speaks; the activation channel cannot request one (the foundation URI is
version-neutral), so this is a deployment-level choice, not a per-request
negotiation. Defaults to `1` — the version the upstream reference lineage
decodes. Set `2` once every client in the deployment speaks V2. See
[x402 payments](./x402-payments.md) for the full version model.

## Serving the handler

Once you have `handler`, mount it in any HTTP framework. The recipe is in [Framework Integration](../agent/framework-integration.md).

## When `toA2x()` is enough

If you don't need any of the customizations above, don't bother with manual wiring. `toA2x()` produces the same handler internally and exposes it if you need to reach back in:

```ts
const app = toA2x(agent, { port: 4000, defaultUrl: '...' });
// app gives you the running server; access .handler if you need it.
```

The standalone helper enables configured transports and advertises exactly those bindings:

```ts
import { A2A_TRANSPORTS, toA2x } from '@a2x/sdk';

const app = toA2x(agent, {
  port: 4000,
  defaultUrl: 'http://localhost:4000/a2a',
  transports: [
    A2A_TRANSPORTS.HTTP_JSON,
    A2A_TRANSPORTS.JSONRPC,
  ],
});
```

The first entry is the primary AgentCard interface. Omitting `transports` preserves the existing JSON-RPC-only behavior. HTTP+JSON is v1.0-only; configuring it with `protocolVersion: '0.3'` throws during setup.
