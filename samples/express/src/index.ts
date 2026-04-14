import express from 'express';
import {
  LlmAgent,
  BaseLlmProvider,
  InMemoryRunner,
  AgentExecutor,
  StreamingMode,
  InMemoryTaskStore,
  A2XAgent,
  DefaultRequestHandler,
  createSSEStream,
} from 'a2x';
import type {
  LlmRequest,
  LlmResponse,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from 'a2x';

// ─── Echo Provider (returns the user message as-is) ───

class EchoProvider extends BaseLlmProvider {
  readonly name = 'echo';
  constructor() { super({ model: 'echo' }); }
  async generateContent(request: LlmRequest): Promise<LlmResponse> {
    const lastMsg = request.contents[request.contents.length - 1];
    const text = lastMsg?.parts?.map((p) => ('text' in p ? p.text : '')).join('') ?? '';
    return { content: [{ text: `Echo: ${text}` }], finishReason: 'stop' };
  }
}

// ─── 1. Define your agent ───

const agent = new LlmAgent({
  name: 'echo-agent',
  description: 'A simple echo agent that returns your message.',
  provider: new EchoProvider(),
  instruction: 'You are a helpful echo agent.',
});

// ─── 2. Wire up a2x ───

const runner = new InMemoryRunner({ agent, appName: agent.name });
const agentExecutor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
});
const taskStore = new InMemoryTaskStore();
const a2xAgent = new A2XAgent(taskStore, agentExecutor);

a2xAgent.setDefaultUrl('http://localhost:3000/a2a');
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
    const card = handler.getAgentCard('0.3');
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

const PORT = Number(process.env.PORT) || 3000;

app.listen(PORT, () => {
  console.log(`a2x Express sample running on http://localhost:${PORT}`);
  console.log(`Agent card: http://localhost:${PORT}/.well-known/agent.json`);
  console.log(`JSON-RPC:   POST http://localhost:${PORT}/a2a`);
});
