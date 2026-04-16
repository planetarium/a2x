# LLM Providers

`@a2x/sdk` includes built-in providers for three major LLM services. Each provider is in a separate entry point to keep the main bundle small (tree-shakeable).

---

## Google Gemini

```bash
npm install @google/genai
```

```typescript
import { GoogleProvider } from '@a2x/sdk/google';

const provider = new GoogleProvider({
  model: 'gemini-2.5-flash',          // or 'gemini-2.5-pro', etc.
  apiKey: process.env.GOOGLE_API_KEY!,
});
```

**Environment variable:** `GOOGLE_API_KEY`

---

## Anthropic Claude

```bash
npm install @anthropic-ai/sdk
```

```typescript
import { AnthropicProvider } from '@a2x/sdk/anthropic';

const provider = new AnthropicProvider({
  model: 'claude-sonnet-4-20250514',   // or any Claude model
  apiKey: process.env.ANTHROPIC_API_KEY!,
});
```

**Environment variable:** `ANTHROPIC_API_KEY`

---

## OpenAI GPT

```bash
npm install openai
```

```typescript
import { OpenAIProvider } from '@a2x/sdk/openai';

const provider = new OpenAIProvider({
  model: 'gpt-4o',                     // or 'gpt-4o-mini', etc.
  apiKey: process.env.OPENAI_API_KEY!,
});
```

**Environment variable:** `OPENAI_API_KEY`

---

## Using a Provider with LlmAgent

```typescript
import { LlmAgent } from '@a2x/sdk';
import { AnthropicProvider } from '@a2x/sdk/anthropic';

const agent = new LlmAgent({
  name: 'my-agent',
  description: 'A helpful agent.',
  provider: new AnthropicProvider({
    model: 'claude-sonnet-4-20250514',
    apiKey: process.env.ANTHROPIC_API_KEY!,
  }),
  instruction: 'You are a helpful assistant.',
});
```

---

## Import Paths

| Provider | Import Path | Peer Dependency |
|----------|-------------|-----------------|
| Google Gemini | `@a2x/sdk/google` | `@google/genai >= 1.0.0` |
| Anthropic Claude | `@a2x/sdk/anthropic` | `@anthropic-ai/sdk >= 0.52.0` |
| OpenAI GPT | `@a2x/sdk/openai` | `openai >= 4.0.0` |

All peer dependencies are optional — only install the one you need.
