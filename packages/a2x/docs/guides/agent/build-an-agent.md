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

## What the agent receives: `InvocationContext`

Custom agents that extend `BaseAgent` directly are handed an `InvocationContext` on every turn:

```ts
class MyAgent extends BaseAgent {
  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> { /* … */ }
}
```

The fields that matter most for everyday agent code:

| Field | Use it for |
|---|---|
| `context.taskId` | The A2A `Task.id` of the current turn (wire-protocol identifier). **Stable across `request-input` → resume.** Bind per-task durable state (paid rows, approval tokens, …) to this — not to `session.id`. |
| `context.contextId` | The A2A `contextId` of the current turn. One `contextId` umbrellas many tasks in the same conversation (1:N), so this is the right key for state that should outlive a single task but stay scoped to one conversation. |
| `context.input` | Populated only on resume turns of a task that previously emitted `request-input`. Carries the prior turn's record and (optionally) a hook outcome. See [Protocol Extensions](../advanced/extensions.md). |
| `context.session` | The runner's per-invocation `Session`. `session.id` is **regenerated on every turn** and is not safe to bind per-task state to — use `taskId` / `contextId` instead. |
| `context.signal` | `AbortSignal` for the run. Listen if you do anything cancellable (e.g. external HTTP). |

`taskId` and `contextId` are set by the default `AgentExecutor` whenever the agent is dispatched under an A2A task; they are `undefined` only when the `Runner` is invoked standalone, with no enclosing A2A task.

## AgentEvent variants

Custom agents that extend `BaseAgent` directly express their output by yielding `AgentEvent`s. The default `AgentExecutor` knows how to map each variant onto an A2A artifact or task status update.

| Variant | Use it for |
|---|---|
| `text` | Streaming or final text output. Multiple `text` events accumulate into one text artifact. |
| `file` | An attached file (URL or base64 raw). One artifact per event. |
| `data` | A structured non-text payload (`mediaType` indicates the shape). One artifact per event. |
| `toolCall` / `toolResult` | LLM-style tool turns (consumed by `LlmAgent` plumbing; surface only when you're modeling the round-trip yourself). |
| `request-input` | Halt the agent and ask the client for input — most often a payment (via `x402RequestPayment`) or an approval. The executor sets the task to `input-required` and persists a small bookkeeping record so the resume turn can read what was asked for. See [Protocol Extensions](../advanced/extensions.md) and [x402 Payments](../advanced/x402-payments.md). |
| `done` | Mark the run finished. Required at the end of every successful run. |
| `error` | Mark the task failed with the given `Error`. |

## Next

- [Choose an LLM Provider](./providers.md) — swap between Gemini, Claude, and GPT.
- [Add Tools](./tools.md) — give the agent functions it can call.
- [Multi-Agent Patterns](./multi-agent.md) — delegate, pipeline, fan out.
