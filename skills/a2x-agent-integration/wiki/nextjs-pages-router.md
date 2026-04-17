# Next.js Pages Router

API Routes for A2A protocol integration using `@a2x/sdk` in Next.js Pages Router projects.

---

## Directory Structure

```
src/
├── lib/
│   └── a2x-setup.ts                  # A2X setup module (shared singleton)
└── pages/
    └── api/
        ├── a2a.ts                     # JSON-RPC POST endpoint
        └── well-known/
            └── agent.json.ts          # AgentCard GET endpoint
```

> Note: Next.js Pages Router cannot serve `/.well-known/agent.json` directly due to the dot-prefixed path. Use `/api/well-known/agent.json` or configure a rewrite in `next.config.ts`.

---

## Setup Module

`src/lib/a2x-setup.ts` — same as App Router (see [nextjs-app-router.md](./nextjs-app-router.md#setup-module)).

---

## AgentCard Endpoint

`src/pages/api/well-known/agent.json.ts`:

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { a2xAgent } from '@/lib/a2x-setup';

export default function agentCardHandler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const card = a2xAgent.getAgentCard();
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(card);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal error',
    });
  }
}
```

### Rewrite for Standard Path

To serve the AgentCard at the standard `/.well-known/agent.json` path, add a rewrite in `next.config.ts`:

```typescript
const nextConfig = {
  async rewrites() {
    return [
      {
        source: '/.well-known/agent.json',
        destination: '/api/well-known/agent.json',
      },
    ];
  },
};
export default nextConfig;
```

---

## JSON-RPC Endpoint

`src/pages/api/a2a.ts`:

```typescript
import type { NextApiRequest, NextApiResponse } from 'next';
import { handler } from '@/lib/a2x-setup';
import { createSSEStream } from '@a2x/sdk';
import type { RequestContext } from '@a2x/sdk';

// Disable body parsing — we need the raw JSON object, but Next.js parses it by default
// Actually, Next.js Pages API parses JSON by default, so req.body is already an object.

export default async function a2aHandler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Build RequestContext for authentication
  const context: RequestContext = {
    headers: req.headers as Record<string, string | string[] | undefined>,
    query: req.query as Record<string, string | string[] | undefined>,
  };

  try {
    const result = await handler.handle(req.body, context);

    // Streaming → SSE
    if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');

      const stream = createSSEStream(result as AsyncGenerator);
      const reader = stream.getReader();

      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(typeof value === 'string' ? value : new TextDecoder().decode(value));
        }
      } catch (error) {
        const errorData = JSON.stringify({
          error: error instanceof Error ? error.message : 'Streaming error',
        });
        res.write(`event: error\ndata: ${errorData}\n\n`);
      }
      res.end();
      return;
    }

    // Synchronous → JSON
    res.json(result);
  } catch {
    res.status(400).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  }
}
```

---

## Pages Router-Specific Notes

### SSE Streaming

Pages Router uses the Node.js `res.write()` / `res.end()` API (like Express), not the Web Streams API. Use `createSSEStream().getReader()` to read chunks and write them to the response.

### Body Parsing

Next.js Pages API Routes automatically parse JSON bodies. `req.body` is already an object — no need for `request.json()`.

### Bundling Issues

Same as App Router — add `@a2x/sdk` to `serverExternalPackages` if needed:

```typescript
const nextConfig = {
  serverExternalPackages: ['@a2x/sdk'],
};
```
