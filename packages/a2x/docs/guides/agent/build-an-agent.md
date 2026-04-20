# Build an Agent

The [Quickstart](../quickstart.md) shows the shortest path. This guide explains each field so you can tailor the agent to your use case.

## Anatomy of `LlmAgent`

```ts
import { LlmAgent } from '@a2x/sdk';
import { GoogleProvider } from '@a2x/sdk/google';

const agent = new LlmAgent({
  name: 'support_agent',
  description: 'Answers customer support questions about the Acme API.',
  instruction: `
    You are a support agent for Acme.
    Always cite the section of the docs you used to answer.
    If you don't know, say so.
  `,
  provider: new GoogleProvider({
    model: 'gemini-2.5-flash',
    apiKey: process.env.GOOGLE_API_KEY!,
  }),
});
```

| Field | Purpose |
|---|---|
| `name` | Stable identifier; surfaced on the AgentCard and used for routing when composed. Use `snake_case`. |
| `description` | One-liner that tells other agents (and humans reading the card) what this agent does. |
| `instruction` | System prompt — shapes every response. Treat this as product copy; iterate on it. |
| `provider` | The LLM backend. See [Choose an LLM Provider](./providers.md). |
| `tools` | Optional functions the agent can invoke. See [Add Tools](./tools.md). |

## Serving the agent

`toA2x()` is the one-liner that turns an agent into a running HTTP server:

```ts
import { toA2x } from '@a2x/sdk';

toA2x(agent, {
  port: 4000,
  defaultUrl: 'http://localhost:4000/a2a',
});
```

`defaultUrl` is the **public URL** other agents should use to reach you. In production this is your deployed domain; locally it's fine to use `localhost`. This value ends up on the AgentCard.

When `toA2x()` is too opinionated — e.g. you already have an Express app, you need custom middleware, or you want fine-grained control over the AgentCard — see [Manual Wiring](../advanced/manual-wiring.md).

## Verifying the agent is up

With the server running, hit the well-known endpoint:

```bash
curl http://localhost:4000/.well-known/agent.json | jq
```

You should see an AgentCard echoing your `name`, `description`, and the transport (`JSONRPC` by default). If another agent or a client calls this URL, they get exactly the same answer — that's how discovery works in A2A.

## Iterating on the instruction

The `instruction` field is where most of your agent's behavior lives. A few practical tips:

- **Describe the persona and the guardrails separately.** Persona first ("You are…"), then what to do and what not to do.
- **Tell the model how to handle unknowns.** "If you don't know, say so" prevents hallucination more reliably than "be accurate".
- **Keep tool usage hints here, not in the tool definitions.** "Always call `get_weather` before guessing a temperature" belongs in the instruction; the tool's own `description` should just describe the tool.

## Next

- [Choose an LLM Provider](./providers.md) — swap between Gemini, Claude, and GPT.
- [Add Tools](./tools.md) — give the agent functions it can call.
- [Multi-Agent Patterns](./multi-agent.md) — delegate, pipeline, fan out.
