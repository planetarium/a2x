# Next.js App Router

Route Handlers for A2A protocol integration using `@a2x/sdk` in Next.js App Router projects.

---

## Directory Structure

```
src/
├── lib/
│   └── a2x-setup.ts                    # A2X setup module (shared singleton)
└── app/
    ├── .well-known/
    │   └── agent.json/
    │       └── route.ts                 # AgentCard GET endpoint
    └── api/
        └── a2a/
            └── route.ts                 # JSON-RPC POST endpoint
```

Next.js App Router uses folder-based routing. The `.well-known/agent.json/` folder (with dots) is handled correctly.

---

## Setup Module

`src/lib/a2x-setup.ts`:

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
import { AnthropicProvider } from '@a2x/sdk/anthropic';
// Or: import { GoogleProvider } from '@a2x/sdk/google';
// Or: import { OpenAIProvider } from '@a2x/sdk/openai';

const agent = new LlmAgent({
  name: 'my-agent',
  description: 'A helpful AI agent.',
  provider: new AnthropicProvider({
    model: 'claude-sonnet-4-20250514',
    apiKey: process.env.ANTHROPIC_API_KEY!,
  }),
  instruction: 'You are a helpful assistant.',
});

const runner = new InMemoryRunner({ agent, appName: agent.name });
const executor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
});
const taskStore = new InMemoryTaskStore();

export const a2xAgent = new A2XAgent({ taskStore, executor, protocolVersion: '1.0' })
  .setDefaultUrl(`${process.env.BASE_URL ?? 'http://localhost:3000'}/api/a2a`)
  .addSkill({
    id: 'chat',
    name: 'General Chat',
    description: 'General conversation and Q&A',
    tags: ['chat', 'general'],
  });

export const handler = new DefaultRequestHandler(a2xAgent);
```

### globalThis Singleton for HMR

In dev mode, Next.js HMR re-evaluates server modules. If you need stable singletons (e.g., to preserve in-memory task state across hot reloads), use `globalThis` caching:

```typescript
const GLOBAL_KEY = Symbol.for('a2x-handler');

function getOrCreate() {
  const g = globalThis as Record<symbol, { handler: DefaultRequestHandler; a2xAgent: A2XAgent } | undefined>;
  if (!g[GLOBAL_KEY]) {
    // ... create agent, runner, executor, taskStore, a2xAgent, handler ...
    g[GLOBAL_KEY] = { handler, a2xAgent };
  }
  return g[GLOBAL_KEY]!;
}

export const { handler, a2xAgent } = getOrCreate();
```

This is the same pattern Next.js recommends for Prisma and other singleton clients.

---

## AgentCard Endpoint

`src/app/.well-known/agent.json/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { a2xAgent } from '@/lib/a2x-setup';

export async function GET(): Promise<Response> {
  try {
    const card = a2xAgent.getAgentCard();
    return NextResponse.json(card, {
      headers: { 'Cache-Control': 'public, max-age=3600' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Internal error' },
      { status: 500 },
    );
  }
}
```

Only exporting `GET` means Next.js automatically returns 405 for other methods.

---

## JSON-RPC Endpoint

`src/app/api/a2a/route.ts`:

```typescript
import { NextResponse } from 'next/server';
import { handler } from '@/lib/a2x-setup';
import { createSSEStream } from '@a2x/sdk';
import type { RequestContext } from '@a2x/sdk';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

export async function POST(request: Request): Promise<Response> {
  // 1. Parse JSON body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
      { status: 400 },
    );
  }

  // 2. Build RequestContext for authentication
  const context: RequestContext = {
    headers: Object.fromEntries(request.headers.entries()),
    query: Object.fromEntries(new URL(request.url).searchParams.entries()),
  };

  // 3. Handle the request
  const result = await handler.handle(body, context);

  // 4. Streaming → SSE response
  if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
    const stream = createSSEStream(result as AsyncGenerator);
    return new Response(stream, { headers: SSE_HEADERS });
  }

  // 5. Synchronous → JSON response
  return NextResponse.json(result);
}
```

---

## Next.js-Specific Notes

### Bundling Issues

If the build fails with module resolution errors, add to `next.config.ts`:

```typescript
const nextConfig = {
  serverExternalPackages: ['@a2x/sdk'],
};
export default nextConfig;
```

### Environment Variables

- Use `.env.local` for secrets (auto-loaded by Next.js, already in `.gitignore`).
- Do **not** prefix API keys with `NEXT_PUBLIC_` — they must remain server-side only.
- `@/lib/a2x-setup` uses the `@/` path alias (configured in `tsconfig.json`).

### Runtime

If using edge runtime, note that `@a2x/sdk` uses Node.js built-in modules. Stick with the default Node.js runtime:

```typescript
// Do NOT set this for a2x routes:
// export const runtime = 'edge';
```
