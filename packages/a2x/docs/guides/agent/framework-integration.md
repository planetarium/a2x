# Framework Integration

`toA2x()` starts a standalone HTTP server. If you already have an Express, Next.js, Fastify, or Hono app — or you need custom middleware, auth, or routing — use **manual wiring** and mount A2X's request handler yourself.

This guide shows the two most common hosts: Express and Next.js App Router. The same pattern works in any framework; the only thing that changes is how you read the request body and write the response.

## The shared setup

Regardless of host, you build the same pieces up front:

```ts
import {
  LlmAgent,
  InMemoryRunner,
  AgentExecutor,
  StreamingMode,
  InMemoryTaskStore,
  A2XServer,
  DefaultRequestHandler,
  createSSEStream,
} from '@a2x/sdk';
import type { RequestContext } from '@a2x/sdk';
import { GoogleProvider } from '@a2x/sdk/google';

const agent = new LlmAgent({
  name: 'my_agent',
  description: 'My A2A agent.',
  instruction: 'You are a helpful assistant.',
  provider: new GoogleProvider({
    model: 'gemini-2.5-flash',
    apiKey: process.env.GOOGLE_API_KEY!,
  }),
});

const runner = new InMemoryRunner({ agent, appName: agent.name });
const executor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
});
const taskStore = new InMemoryTaskStore();

const a2xServer = new A2XServer({ taskStore, executor })
  .setDefaultUrl('https://my-agent.example.com/a2a')
  .addSkill({
    id: 'chat',
    name: 'Chat',
    description: 'General conversation.',
    tags: ['chat'],
  });

const handler = new DefaultRequestHandler(a2xServer);
```

`handler` is what you mount. See [Manual Wiring](../advanced/manual-wiring.md) for why each step exists.

This setup advertises and serves JSON-RPC. To mount the v1.0 HTTP+JSON binding instead, make the binding explicit in both the card and the HTTP adapter:

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

`setDefaultTransport()` changes AgentCard metadata; `HttpJsonRequestHandler` is the route implementation. Mount both together so the card advertises only a reachable binding.

## Express

```ts
import express from 'express';

const app = express();
app.use(express.json());

app.get('/.well-known/agent.json', (_req, res) => {
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

    // Detach this response on client disconnect. createSSEStream keeps
    // draining the source so Task execution and persistence continue.
    // Use `res.close` — `req.close` fires before streaming begins.
    res.on('close', () => {
      void reader.cancel().catch(() => {});
    });

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

Three things to notice:

1. `handler.handle()` returns either a plain object (regular response) or an async iterable (streaming response). Branch on `Symbol.asyncIterator`.
2. `createSSEStream()` wraps the async iterable as an SSE-formatted `ReadableStream`.
3. Wiring `res.on('close') → reader.cancel()` detaches the dead response. `createSSEStream()` stops enqueuing bytes but continues draining the source so the Task can finish and other subscribers keep receiving events. See [Streaming Responses](./streaming.md#client-disconnect-detaches-the-stream) for the lifecycle details.

### Express with HTTP+JSON

Mount the REST adapter at the same base path advertised in the AgentCard. It resolves the complete v1.0 route set, including `/message:send`, `/message:stream`, `/tasks`, task subscription, push-config CRUD, and `/extendedAgentCard`:

```ts
app.use('/a2a', async (req, res) => {
  const response = await httpJsonHandler.handle({
    method: req.method,
    url: new URL(req.originalUrl, 'https://my-agent.example.com'),
    body: req.body,
    context: { headers: req.headers, query: req.query },
  });

  res.status(response.status).set(response.headers);
  if (response.body && typeof response.body === 'object' &&
      Symbol.asyncIterator in response.body) {
    const stream = createSSEStream(response.body);
    const reader = stream.getReader();
    res.on('close', () => void reader.cancel().catch(() => {}));
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(typeof value === 'string' ? value : new TextDecoder().decode(value));
    }
    res.end();
  } else {
    res.send(response.body);
  }
});
```

## Next.js App Router

```ts
// app/.well-known/agent.json/route.ts
export async function GET() {
  return Response.json(handler.getAgentCard());
}
```

```ts
// app/a2a/route.ts
export async function POST(request: Request) {
  const body = await request.json();
  const result = await handler.handle(body, { headers: request.headers });

  if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
    const stream = createSSEStream(result);
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
      },
    });
  }

  return Response.json(result);
}
```

`createSSEStream()` returns a `ReadableStream`, which the standard `Response` constructor accepts directly — no manual pump loop needed.

## Fastify, Hono, etc.

For JSON-RPC, the recipe is always the same:

1. Expose `GET /.well-known/agent.json` → `handler.getAgentCard()`.
2. Expose `POST /a2a` → `handler.handle(body, { headers, query })`.
3. Detect async iterable → stream with `createSSEStream()`; otherwise respond with JSON.

The only framework-specific bit is how the framework reads bodies and writes streams.

For HTTP+JSON, pass the framework request to `HttpJsonRequestHandler.handle()` and write its status, headers, and body as shown above. `HttpJsonRequestHandler.canHandle()` is available when JSON-RPC and REST share a server and you need to dispatch selectively.

## Where to mount

The URLs above are conventions, not requirements — but they're what clients and the A2A discovery flow expect. If you host multiple agents on the same domain, use per-agent prefixes (`/agents/:name/.well-known/agent.json` + `/agents/:name/a2a`) and reflect that in each agent's `defaultUrl`.
