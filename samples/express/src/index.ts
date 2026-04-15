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
  ApiKeyAuthorization,
  OAuth2DeviceCodeAuthorization,
} from 'a2x';
import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
  RequestContext,
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
  protocolVersion: '1.0',
});

a2xAgent.setDefaultUrl(`${process.env.BASE_URL}/a2a`);
a2xAgent.addSkill({
  id: 'echo',
  name: 'Echo',
  description: 'Echoes back the user message',
  tags: ['echo'],
  examples: ['Hello, agent!'],
});

// ─── 3. Security: API Key + OAuth2 Device Code (OR logic) ───

a2xAgent
  .addSecurityScheme(
    'apiKey',
    new ApiKeyAuthorization({
      in: 'header',
      name: 'x-api-key',
      description: 'API key for agent access',
      keys: process.env.API_KEYS
        ? process.env.API_KEYS.split(',')
        : undefined,
    }),
  )
  .addSecurityScheme(
    'deviceCode',
    new OAuth2DeviceCodeAuthorization({
      deviceAuthorizationUrl: `${process.env.BASE_URL ?? 'https://auth.example.com'}/device/authorize`,
      tokenUrl: `${process.env.BASE_URL ?? 'https://auth.example.com'}/oauth/token`,
      scopes: { 'agent:invoke': 'Invoke the agent' },
      description: 'OAuth2 Device Code flow for CLI / headless clients',
      tokenValidator: async (token, _requiredScopes) => {
        console.log('tokenValidator', token, _requiredScopes);
        const validToken = process.env.AUTH_TOKEN;
        if (!validToken) {
          return { authenticated: true };
        }
        if (token !== validToken) {
          return { authenticated: false, error: 'Invalid access token' };
        }
        return {
          authenticated: true,
          principal: { sub: 'device-user' },
          scopes: ['agent:invoke'],
        };
      },
    }),
  )
  // OR logic: either API Key or Device Code satisfies auth
  .addSecurityRequirement({ apiKey: [] })
  .addSecurityRequirement({ deviceCode: ['agent:invoke'] });

const handler = new DefaultRequestHandler(a2xAgent);

// ─── 4. Express app ───

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
  // Build framework-agnostic RequestContext for authentication
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

// ─── 5. Start ───

const PORT = Number(process.env.PORT) || 4000;

app.listen(PORT, () => {
  console.log(`a2x Express sample running on http://localhost:${PORT}`);
  console.log(`Agent card: http://localhost:${PORT}/.well-known/agent.json`);
  console.log(`JSON-RPC:   POST http://localhost:${PORT}/a2a`);
  console.log(`Auth:       API Key (x-api-key header) OR OAuth2 Device Code (Bearer token)`);
  if (!process.env.API_KEYS && !process.env.AUTH_TOKEN) {
    console.log(`            No API_KEYS / AUTH_TOKEN set — running in pass-through mode`);
  }
});
