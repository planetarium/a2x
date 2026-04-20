# Multi-Agent Patterns

A2X ships three composition primitives for fixed topologies plus the dynamic `AgentTool` delegation (see [Add Tools](./tools.md)).

| Pattern | Shape | When to use |
|---|---|---|
| `SequentialAgent` | A → B → C | Pipelines where each step refines the previous one. |
| `ParallelAgent` | A, B, C run concurrently | Fan-out/fan-in. Independent subtasks. |
| `LoopAgent` | Repeat A until condition | Iterative refinement, review cycles. |

All three implement the same interface as `LlmAgent`, so they can be served by `toA2x()` or nested inside other patterns.

## Sequential — pipeline

```ts
import { SequentialAgent, LlmAgent } from '@a2x/sdk';

const outline = new LlmAgent({
  name: 'outline',
  description: 'Produces an outline.',
  instruction: 'Return a 5-point outline.',
  provider,
});

const draft = new LlmAgent({
  name: 'draft',
  description: 'Writes a full draft from an outline.',
  instruction: 'Expand each outline point into 1-2 paragraphs.',
  provider,
});

const edit = new LlmAgent({
  name: 'edit',
  description: 'Tightens prose.',
  instruction: 'Reduce word count by 30% without losing meaning.',
  provider,
});

const pipeline = new SequentialAgent({
  name: 'writer',
  description: 'Outline → draft → edit pipeline.',
  agents: [outline, draft, edit],
});
```

Input to the pipeline flows into the first agent; each agent's output becomes the next agent's input.

## Parallel — fan-out

```ts
import { ParallelAgent, LlmAgent } from '@a2x/sdk';

const summarizer = new LlmAgent({ /* summarizes */ });
const translator = new LlmAgent({ /* translates */ });
const sentiment = new LlmAgent({ /* classifies tone */ });

const fanout = new ParallelAgent({
  name: 'analyze',
  description: 'Analyzes a document from three angles in parallel.',
  agents: [summarizer, translator, sentiment],
});
```

All three agents run concurrently on the same input. Use this when the sub-tasks are independent — no agent needs another's output.

## Loop — iterative refinement

```ts
import { LoopAgent, LlmAgent } from '@a2x/sdk';

const reviewer = new LlmAgent({
  name: 'reviewer',
  description: 'Reviews a draft and decides whether to stop.',
  instruction: `
    Score the draft 0-10. If score >= 8, start your response with "DONE:".
    Otherwise start with "REVISE:" and explain what to fix.
  `,
  provider,
});

const iterativeWriter = new LoopAgent({
  name: 'iterative_writer',
  description: 'Refines a draft until the reviewer says DONE.',
  agents: [writer, reviewer],
  maxIterations: 5,
  shouldExit: (output) => output?.startsWith('DONE:') ?? false,
});
```

`shouldExit` receives each iteration's output and returns `true` when the loop is done. `maxIterations` is a hard cap to prevent runaway costs.

## Nesting

Patterns compose freely:

```ts
const research = new ParallelAgent({ agents: [webSearch, kbSearch] });
const analyze = new SequentialAgent({ agents: [research, summarize, critique] });
const refine = new LoopAgent({ agents: [analyze, reviewer], maxIterations: 3 });
```

Any of these can be served directly by `toA2x(refine, { ... })`.

## When to use `AgentTool` instead

- Use a **pattern** when the topology is known up-front.
- Use `AgentTool` when the outer agent should decide at runtime which sub-agent to invoke and how many times.

Patterns are cheaper (no LLM routing overhead) and easier to reason about. `AgentTool` is more flexible.
