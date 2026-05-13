import 'dotenv/config';
import express from 'express';
import {
  LlmAgent,
  InMemoryRunner,
  AgentExecutor,
  StreamingMode,
  InMemoryTaskStore,
  A2XAgent,
  DefaultRequestHandler,
  createSSEStream,
} from '@a2x/sdk';
import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  RequestContext,
} from '@a2x/sdk';
import { AnthropicProvider } from '@a2x/sdk/anthropic';

// ─── 1. Define your agent ───

const agent = new LlmAgent({
  name: 'echo-agent',
  description: 'A simple echo agent that returns your message.',
  provider: new AnthropicProvider({
    model: 'claude-sonnet-4-6',
    apiKey: process.env.ANTHROPIC_API_KEY!,
  }),
  instruction: 'You are a helpful echo agent.',
});

// ─── 2. Wire up a2x ───

const runner = new InMemoryRunner({ agent, appName: agent.name });
const agentExecutor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
});
const taskStore = new InMemoryTaskStore();
const a2xAgent = new A2XAgent({
  taskStore,
  executor: agentExecutor,
  protocolVersion: '1.0',
});

a2xAgent.setDefaultUrl(`${process.env.BASE_URL ?? 'http://localhost:4000'}/a2a`);
a2xAgent.addSkill({
  id: 'echo',
  name: 'Echo',
  description: 'Echoes back the user message',
  tags: ['echo'],
  examples: ['Hello, agent!'],
});

const handler = new DefaultRequestHandler(a2xAgent);

// ─── 3. Express app ───

const app = express();
app.use(express.json());

app.use(
  (err: unknown, _req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (err instanceof SyntaxError && 'body' in err) {
      res.status(200).json({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: 'Parse error' },
      });
      return;
    }
    next(err);
  },
);

app.get('/.well-known/agent.json', (_req, res) => {
  try {
    const card = handler.getAgentCard();
    res.json(card);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal error',
    });
  }
});

app.post('/a2a', async (req, res) => {
  const context: RequestContext = {
    headers: req.headers as Record<string, string | string[] | undefined>,
    query: req.query as Record<string, string | string[] | undefined>,
  };

  let result: Awaited<ReturnType<typeof handler.handle>>;
  try {
    result = await handler.handle(req.body, context);
  } catch (err) {
    const id = (req.body as { id?: unknown } | undefined)?.id ?? null;
    res.status(200).json({
      jsonrpc: '2.0',
      id,
      error: {
        code: -32603,
        message: err instanceof Error ? err.message : 'Internal error',
      },
    });
    return;
  }

  if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const stream = createSSEStream(
      result as AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent>,
    );
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

  res.json(result);
});

// ─── 4. Start ───

const PORT = Number(process.env.PORT) || 4000;

app.listen(PORT, '0.0.0.0', () => {
  console.log(`a2x Express (no-auth) sample running on http://0.0.0.0:${PORT}`);
  console.log(`Agent card: http://0.0.0.0:${PORT}/.well-known/agent.json`);
  console.log(`JSON-RPC:   POST http://0.0.0.0:${PORT}/a2a`);
});
