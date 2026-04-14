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
} from 'a2x';
import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from 'a2x';
import { GoogleProvider } from 'a2x/google';

// ─── 1. Define your agent ───

const agent = new LlmAgent({
  name: 'echo-agent',
  description: 'A simple echo agent that returns your message.',
  provider: new GoogleProvider({ model: 'gemini-2.5-flash', apiKey: process.env.GOOGLE_API_KEY! }),
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
  protocolVersion: '0.3',
});

a2xAgent.setDefaultUrl(`${process.env.BASE_URL}/a2a`);
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

// Agent Card
app.get('/.well-known/agent.json', (req, res) => {
  try {
    const card = handler.getAgentCard();
    res.json(card);
  } catch (error) {
    res.status(500).json({
      error: error instanceof Error ? error.message : 'Internal error',
    });
  }
});

// JSON-RPC endpoint
app.post('/a2a', async (req, res) => {
  try {
    const result = await handler.handle(req.body);

    // Streaming → SSE
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

    // Standard JSON-RPC response
    res.json(result);
  } catch {
    res.status(400).json({
      jsonrpc: '2.0',
      id: null,
      error: { code: -32700, message: 'Parse error' },
    });
  }
});

// ─── 4. Start ───

const PORT = Number(process.env.PORT) || 4000;

app.listen(PORT, () => {
  console.log(`a2x Express sample running on http://localhost:${PORT}`);
  console.log(`Agent card: http://localhost:${PORT}/.well-known/agent.json`);
  console.log(`JSON-RPC:   POST http://localhost:${PORT}/a2a`);
});
