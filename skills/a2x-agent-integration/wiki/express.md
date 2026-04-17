# Express

Route setup for A2A protocol integration using `@a2x/sdk` in Express projects.

---

## Directory Structure

```
src/
├── lib/
│   └── a2x-setup.ts       # A2X setup module
└── index.ts                # Express app entry point
```

Or for larger projects:

```
src/
├── lib/
│   └── a2x-setup.ts       # A2X setup module
├── routes/
│   └── a2a.ts              # A2A route handlers
└── index.ts                # Express app entry point
```

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
  ApiKeyAuthorization,
} from '@a2x/sdk';
import { GoogleProvider } from '@a2x/sdk/google';

const agent = new LlmAgent({
  name: 'my-agent',
  description: 'A helpful AI agent.',
  provider: new GoogleProvider({
    model: 'gemini-2.5-flash',
    apiKey: process.env.GOOGLE_API_KEY!,
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
  .setDefaultUrl(`${process.env.BASE_URL ?? 'http://localhost:4000'}/a2a`)
  .addSkill({
    id: 'chat',
    name: 'General Chat',
    description: 'General conversation and Q&A',
    tags: ['chat', 'general'],
  })
  // Optional: add authentication
  .addSecurityScheme('apiKey', new ApiKeyAuthorization({
    in: 'header',
    name: 'x-api-key',
    keys: process.env.API_KEYS?.split(','),
  }))
  .addSecurityRequirement({ apiKey: [] });

export const handler = new DefaultRequestHandler(a2xAgent);
```

---

## Complete Express App

```typescript
import 'dotenv/config';
import express from 'express';
import { handler, a2xAgent } from './lib/a2x-setup';
import { createSSEStream } from '@a2x/sdk';
import type { RequestContext } from '@a2x/sdk';

const app = express();
app.use(express.json());

// AgentCard discovery
app.get('/.well-known/agent.json', (_req, res) => {
  try {
    const card = handler.getAgentCard();
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.json(card);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal error',
    });
  }
});

// JSON-RPC endpoint
app.post('/a2a', async (req, res) => {
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
          error: error instanceof Error ? error.message : 'Internal error',
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
});

// Start server
const PORT = Number(process.env.PORT) || 4000;
app.listen(PORT, () => {
  console.log(`Agent running on http://localhost:${PORT}`);
  console.log(`Agent Card: http://localhost:${PORT}/.well-known/agent.json`);
  console.log(`JSON-RPC:   POST http://localhost:${PORT}/a2a`);
});
```

---

## Express-Specific Notes

### Singleton Lifecycle

Express runs as a long-lived process, so module-level singletons are naturally stable. No `globalThis` caching needed.

### Body Parsing

`express.json()` middleware parses the JSON body — `req.body` is already an object.

### Client Disconnect Handling

For cleaner streaming cleanup, listen for client disconnect:

```typescript
const generator = result as AsyncGenerator;
req.on('close', () => {
  generator.return(undefined);
});
```

### CORS

If your agent needs to accept requests from browsers:

```typescript
import cors from 'cors';
app.use(cors());
```

### Environment Variables

Use `dotenv` for `.env` file loading:

```bash
npm install dotenv
```

```typescript
import 'dotenv/config';  // At the top of your entry file
```
