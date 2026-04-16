# Tools & Agent Patterns

---

## FunctionTool

Wrap any async function as a tool the LLM can call:

```typescript
import { FunctionTool } from '@a2x/sdk';

const weatherTool = new FunctionTool({
  name: 'get_weather',
  description: 'Get the current weather for a city.',
  parameters: {
    type: 'object',
    properties: {
      city: { type: 'string', description: 'City name' },
      unit: { type: 'string', enum: ['celsius', 'fahrenheit'], description: 'Temperature unit' },
    },
    required: ['city'],
  },
  execute: async (args, context) => {
    // args is typed based on the parameters schema
    const { city, unit } = args as { city: string; unit?: string };
    // Call your weather API here
    return { temperature: 22, unit: unit ?? 'celsius', city };
  },
});

// Use in an LlmAgent
const agent = new LlmAgent({
  name: 'weather-agent',
  description: 'An agent that reports weather.',
  provider: provider,
  instruction: 'You help users check the weather.',
  tools: [weatherTool],
});
```

**Parameters schema** follows JSON Schema format. The `execute` function receives:
- `args` — The parsed arguments from the LLM
- `context` — `InvocationContext` with session data

---

## AgentTool

Wrap another agent as a tool, enabling agent delegation:

```typescript
import { AgentTool, LlmAgent } from '@a2x/sdk';

const researchAgent = new LlmAgent({
  name: 'researcher',
  description: 'Researches topics in depth.',
  provider: provider,
  instruction: 'You research topics thoroughly.',
});

const researchTool = new AgentTool({ agent: researchAgent });

const mainAgent = new LlmAgent({
  name: 'main-agent',
  description: 'Main orchestrator agent.',
  provider: provider,
  instruction: 'You delegate research tasks to the researcher.',
  tools: [researchTool],
});
```

---

## Multi-Agent Patterns

### SequentialAgent

Runs a pipeline of agents in order. Each agent's output feeds into the next.

```typescript
import { SequentialAgent } from '@a2x/sdk';

const pipeline = new SequentialAgent({
  name: 'pipeline',
  description: 'Research then summarize.',
  subAgents: [researchAgent, summaryAgent],
});
```

### ParallelAgent

Runs multiple agents concurrently.

```typescript
import { ParallelAgent } from '@a2x/sdk';

const parallel = new ParallelAgent({
  name: 'parallel-search',
  description: 'Search multiple sources in parallel.',
  subAgents: [webSearchAgent, dbSearchAgent, cacheAgent],
});
```

### LoopAgent

Runs an agent iteratively until an exit condition is met.

```typescript
import { LoopAgent } from '@a2x/sdk';

const refinementLoop = new LoopAgent({
  name: 'refiner',
  description: 'Iteratively refine the answer.',
  agent: refinementAgent,
  maxIterations: 5,
});
```

---

## Combining Tools and Agents

A common pattern is to have a main agent with both function tools and agent tools:

```typescript
const agent = new LlmAgent({
  name: 'orchestrator',
  description: 'Main orchestrator with tools and sub-agents.',
  provider: provider,
  instruction: 'You coordinate between tools and sub-agents.',
  tools: [
    weatherTool,                          // FunctionTool
    new AgentTool({ agent: researcher }), // AgentTool
  ],
});
```
