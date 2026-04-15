import {
  LlmAgent,
  InMemoryRunner,
  AgentExecutor,
  StreamingMode,
  InMemoryTaskStore,
  A2XAgent,
  DefaultRequestHandler,
  OAuth2DeviceCodeAuthorization,
} from "a2x";
import { AnthropicProvider } from "a2x/anthropic";

const agent = new LlmAgent({
  name: "sample_agent",
  provider: new AnthropicProvider({ model: "claude-sonnet-4-20250514", apiKey: process.env.ANTHROPIC_API_KEY! }),
  description: "A sample A2A agent built with Next.js and a2x SDK.",
  instruction:
    "You are a helpful assistant that responds to user queries. Be concise and informative.",
});

const runner = new InMemoryRunner({ agent, appName: "sample-nextjs" });

const executor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
});

const taskStore = new InMemoryTaskStore();

export const a2xAgent = new A2XAgent({ taskStore, executor, protocolVersion: '1.0' })
  .setDefaultUrl("http://localhost:3000/api/a2a")
  .addSkill({
    id: "chat",
    name: "General Chat",
    description: "General conversation and Q&A",
    tags: ["chat", "general"],
  })
  .setCapabilities({ streaming: true })
  .addSecurityScheme(
    'deviceCode',
    new OAuth2DeviceCodeAuthorization({
      deviceAuthorizationUrl: `${process.env.AUTH_ISSUER ?? 'https://auth.example.com'}/device/authorize`,
      tokenUrl: `${process.env.AUTH_ISSUER ?? 'https://auth.example.com'}/oauth/token`,
      scopes: { 'agent:invoke': 'Invoke the agent' },
      description: 'OAuth2 Device Code flow for CLI / headless clients',
      tokenValidator: async (token, _requiredScopes) => {
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
  .addSecurityRequirement({ deviceCode: ['agent:invoke'] });

export const handler = new DefaultRequestHandler(a2xAgent);
