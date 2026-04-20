# Choose an LLM Provider

A2X ships three providers out of the box. Install the underlying SDK and import the corresponding A2X adapter.

## Google Gemini

```bash
npm install @google/genai
```

```ts
import { GoogleProvider } from '@a2x/sdk/google';

const provider = new GoogleProvider({
  model: 'gemini-2.5-flash',
  apiKey: process.env.GOOGLE_API_KEY!,
});
```

## Anthropic Claude

```bash
npm install @anthropic-ai/sdk
```

```ts
import { AnthropicProvider } from '@a2x/sdk/anthropic';

const provider = new AnthropicProvider({
  model: 'claude-sonnet-4-20250514',
  apiKey: process.env.ANTHROPIC_API_KEY!,
});
```

## OpenAI GPT

```bash
npm install openai
```

```ts
import { OpenAIProvider } from '@a2x/sdk/openai';

const provider = new OpenAIProvider({
  model: 'gpt-4o',
  apiKey: process.env.OPENAI_API_KEY!,
});
```

## Picking a model

| Concern | Good default |
|---|---|
| Fast, cheap, general-purpose | `gemini-2.5-flash`, `claude-haiku-4-5`, `gpt-4o-mini` |
| High reasoning quality | `claude-sonnet-4-*`, `gpt-4o`, `gemini-2.5-pro` |
| Long-context (100k+ tokens) | any current-gen model; check the provider's docs for limits |
| Tool use / structured output | all three providers support tool calls; Claude and GPT tend to be the most reliable |

Swap providers freely — the rest of the agent definition is identical.

## Mixing providers across agents

You can use a different provider per agent in the same process. This is the usual pattern when one agent is optimized for latency and another for reasoning:

```ts
const router = new LlmAgent({
  name: 'router',
  description: 'Routes requests to a specialist agent.',
  instruction: 'Pick the best specialist.',
  provider: googleFast,           // fast classifier
  tools: [new AgentTool({ agent: analyst })],
});

const analyst = new LlmAgent({
  name: 'analyst',
  description: 'Deep analysis agent.',
  instruction: 'Think step by step.',
  provider: claudeSonnet,          // slower but higher-quality
});
```

See [Multi-Agent Patterns](./multi-agent.md) for composition options.

## Custom providers

If you need to target a provider A2X doesn't ship (e.g. a self-hosted model), implement the `BaseLlmProvider` interface. The shape is small — `generateContent()` and `generateContentStream()`. See the API reference for the exact contract.
