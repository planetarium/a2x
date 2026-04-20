# Quickstart

Get a working agent and a client talking to each other in under five minutes.

## 1. Install

```bash
npm install @a2x/sdk @google/genai
```

Pick any LLM provider. This guide uses Google Gemini; swap in Anthropic or OpenAI any time (see [Choose an LLM Provider](./agent/providers.md)).

## 2. Run your first agent

```ts
import { LlmAgent, toA2x } from '@a2x/sdk';
import { GoogleProvider } from '@a2x/sdk/google';

toA2x(
  new LlmAgent({
    name: 'hello_agent',
    description: 'A friendly assistant.',
    instruction: 'You are a helpful assistant. Keep answers short.',
    provider: new GoogleProvider({
      model: 'gemini-2.5-flash',
      apiKey: process.env.GOOGLE_API_KEY!,
    }),
  }),
  { port: 4000, defaultUrl: 'http://localhost:4000/a2a' },
);
```

Run it:

```bash
GOOGLE_API_KEY=... npx tsx server.ts
```

That's the whole server. Your agent now responds at:

- `GET http://localhost:4000/.well-known/agent.json` — AgentCard for discovery.
- `POST http://localhost:4000/a2a` — JSON-RPC endpoint.

## 3. Call it from another process

```ts
import { A2XClient } from '@a2x/sdk/client';

const client = new A2XClient('http://localhost:4000/.well-known/agent.json');

const task = await client.sendMessage({
  message: { role: 'user', parts: [{ text: 'Say hi in three words.' }] },
});

console.log(task.status.message?.parts);
```

That's it. You've shipped an A2A-compliant agent and called it from TypeScript.

## Where to go next

| If you want to… | Read |
|---|---|
| Customize the agent's behavior | [Build an Agent](./agent/build-an-agent.md) |
| Give the agent tools it can call | [Add Tools](./agent/tools.md) |
| Compose multiple agents | [Multi-Agent Patterns](./agent/multi-agent.md) |
| Mount the agent into Express/Next.js | [Framework Integration](./agent/framework-integration.md) |
| Stream responses token-by-token | [Streaming Responses](./agent/streaming.md) |
| Lock the agent behind auth | [Authentication](./advanced/authentication.md) |
