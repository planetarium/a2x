import {
  LlmAgent,
  InMemoryRunner,
  AgentExecutor,
  StreamingMode,
  InMemoryTaskStore,
  A2XAgent,
  DefaultRequestHandler,
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

export const a2xAgent = new A2XAgent(taskStore, executor)
  .setDefaultUrl("http://localhost:3000/api/a2a")
  .addSkill({
    id: "chat",
    name: "General Chat",
    description: "General conversation and Q&A",
    tags: ["chat", "general"],
  })
  .setCapabilities({ streaming: true });

export const handler = new DefaultRequestHandler(a2xAgent);
