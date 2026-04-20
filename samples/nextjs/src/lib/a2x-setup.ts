import {
  LlmAgent,
  InMemoryRunner,
  AgentExecutor,
  StreamingMode,
  InMemoryTaskStore,
  InMemoryPushNotificationConfigStore,
  A2XAgent,
  DefaultRequestHandler,
  OAuth2DeviceCodeAuthorization,
} from "@a2x/sdk";
import { AnthropicProvider } from "@a2x/sdk/anthropic";
import { globalTokens } from "@/app/oauth/token/route";

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
const pushNotificationConfigStore = new InMemoryPushNotificationConfigStore();

export const a2xAgent = new A2XAgent({
  taskStore,
  executor,
  protocolVersion: '1.0',
  pushNotificationConfigStore,
})
  .setDefaultUrl("http://localhost:3000/api/a2a")
  .addSkill({
    id: "chat",
    name: "General Chat",
    description: "General conversation and Q&A",
    tags: ["chat", "general"],
  })
  .setCapabilities({ streaming: true, pushNotifications: true })
  .addSecurityScheme(
    'deviceCode',
    new OAuth2DeviceCodeAuthorization({
      deviceAuthorizationUrl: `${process.env.BASE_URL ?? 'http://localhost:3000'}/device/authorize`,
      tokenUrl: `${process.env.BASE_URL ?? 'http://localhost:3000'}/oauth/token`,
      scopes: { 'agent:invoke': 'Invoke the agent' },
      description: 'OAuth2 Device Code flow for CLI / headless clients',
      tokenValidator: async (token, _requiredScopes) => {
        if (!globalTokens.has(token)) {
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
