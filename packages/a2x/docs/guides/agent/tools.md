# Add Tools

Tools are functions the LLM can decide to call. A2X supports two tool shapes: plain functions (`FunctionTool`) and sub-agents used as tools (`AgentTool`).

## FunctionTool

Define what the tool does, describe its parameters with JSON Schema, and hand A2X the implementation. The LLM sees the `name`, `description`, and `parameters` and decides when to call it.

```ts
import { FunctionTool, LlmAgent } from '@a2x/sdk';
import { GoogleProvider } from '@a2x/sdk/google';

const getWeather = new FunctionTool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    properties: {
      location: { type: 'string', description: 'City name, e.g. "Seoul".' },
    },
    required: ['location'],
  },
  execute: async ({ location }) => {
    const res = await fetch(`https://wttr.in/${encodeURIComponent(location)}?format=j1`);
    const data = await res.json();
    return {
      temp_c: data.current_condition[0].temp_C,
      description: data.current_condition[0].weatherDesc[0].value,
    };
  },
});

const agent = new LlmAgent({
  name: 'weather_bot',
  description: 'Tells you the weather.',
  instruction: 'Use get_weather before guessing a temperature.',
  provider: new GoogleProvider({
    model: 'gemini-2.5-flash',
    apiKey: process.env.GOOGLE_API_KEY!,
  }),
  tools: [getWeather],
});
```

### Writing good tool descriptions

The `description` field is what the LLM reads. Keep it **behavioral**:

- Bad: "A function that returns weather data."
- Good: "Get the current weather for a city. Returns `temp_c` and `description`. Call this before answering any weather question."

Tell the model **when to call** and **what it gets back**.

### Returning structured data

`execute` can return any JSON-serializable value. Objects and arrays are passed to the LLM as JSON strings under the hood. Prefer small, flat objects — the LLM will summarize them better.

## AgentTool — use an agent as a tool

Wrap another `LlmAgent` (or any `BaseAgent`) and hand it to the outer agent. The outer agent can delegate by "calling the tool".

```ts
import { AgentTool, LlmAgent } from '@a2x/sdk';

const researcher = new LlmAgent({
  name: 'researcher',
  description: 'Searches the knowledge base.',
  instruction: 'Be thorough. Cite sources.',
  provider: claudeSonnet,
  tools: [searchKb],
});

const orchestrator = new LlmAgent({
  name: 'orchestrator',
  description: 'Delegates research tasks.',
  instruction: 'Use the researcher tool for any fact-finding question.',
  provider: geminiFast,
  tools: [new AgentTool({ agent: researcher })],
});
```

`AgentTool` is the building block for ad-hoc delegation. For fixed topologies (pipeline, parallel, loop) prefer the dedicated patterns in [Multi-Agent Patterns](./multi-agent.md).

## Tool-call lifecycle

1. User message arrives.
2. LLM emits a tool-call with `{ name, arguments }`.
3. A2X finds the matching `FunctionTool`/`AgentTool` and runs `execute`.
4. Result is sent back to the LLM as a tool result.
5. LLM produces the final answer (or chains another tool call).

All of this is automatic — you never handle raw tool-call messages yourself.

## Things to watch out for

- **Keep tool `execute` idempotent where possible.** The LLM may retry on transient errors.
- **Validate inputs defensively.** LLMs occasionally invent fields.
- **Short-circuit on obvious misuse.** Throwing from `execute` with a clear error string is fine; the LLM will see it and can react.
- **Don't expose dangerous capabilities behind vague descriptions.** "Run shell command" without constraints is how you get owned.
