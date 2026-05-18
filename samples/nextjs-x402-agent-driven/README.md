# nextjs-x402-agent-driven sample

An [A2A](https://a2a-protocol.org) agent built with Next.js, `@a2x/sdk`, and the **Anthropic Claude API**. The agent runs Claude with a small **tool registry** — some tools are free (`detect_language`, `word_count`), some are paid (`translate`, `summarize`). On every turn Claude decides which tools to call (zero, one, or many — Anthropic supports parallel tool use); whenever the LLM picks at least one paid tool, the agent yields `x402RequestPayment(...)` with the *summed* per-tool cost. On the resume turn the **agent itself** calls `facilitator.verify()` and `facilitator.settle()` via the SDK's stateless helpers — no SDK-owned payment flow, no custom executor.

The decision to charge is **driven by the LLM at runtime**: free chat / free-tool-only turns pass through without payment, any paid tool in the planned batch triggers the gate before any tool actually runs.

## When to reach for this pattern

- Pricing depends on which **tool** an LLM agent picks (e.g. `web_search` is paid, `local_lookup` is free).
- Pricing depends on the **result of an earlier step** (e.g. lookup a record cheaply, then offer a premium follow-up only when the user wants the deep view).
- Pricing depends on **per-call cost estimates** the agent computes (token count after planning, expected API spend, etc.) rather than the raw user message.

If your pricing is purely a function of the inbound message text, you can apply the same pattern with a smaller agent — inspect `lastUserText(context)` directly inside `agent.run()` and gate without any LLM planning call. The `nextjs-x402` sample shows the simplest "every call is paid" variant.

## How it works

```
Client                 AgentExecutor                      Agent
  │  message/send         │                                  │
  ├──────────────────────►│  forward to agent                │
  │                       ├─────────────────────────────────►│  parseX402PaymentSubmission(ctx.message)
  │                       │                                  │   → undefined (turn 1)
  │                       │                                  │  Claude (planning):
  │                       │                                  │   user msg + 4 tool decls
  │                       │                                  │   → tool_use blocks
  │                       │                                  │  validate every args
  │                       │                                  │  sum paid tool costs
  │                       │  ◄── yield* x402RequestPayment   │   if total > 0
  │                       │       (request-input AgentEvent) │
  │                       │  set task = input-required       │
  │  ◄────────────────────┤  + x402.payment.required         │
  │  (input-required)     │                                  │
  │                       │                                  │
  │  signs PaymentPayload │                                  │
  │  message/send (resubmit, with payment metadata)          │
  ├──────────────────────►│  forward to agent                │
  │                       ├─────────────────────────────────►│  parseX402PaymentSubmission(ctx.message)
  │                       │                                  │   → { status: 'submitted', payload }
  │                       │                                  │  Claude (planning) again → tool_use
  │                       │                                  │  pickX402Requirement + validateShape
  │                       │                                  │  facilitator.verify(payload, requirement)
  │                       │                                  │  [insert custom logic here]
  │                       │                                  │  facilitator.settle(payload, requirement)
  │                       │                                  │  execute every tool in order
  │                       │                                  │  Claude (summary) with all tool_results
  │                       │  ◄── toolCall + toolResult * N    │
  │                       │  ◄── done with completion        │
  │                       │       metadata (receipt)         │
  │  ◄────────────────────┤  task = completed                │
  │  (completed +         │  + x402.payment.receipts         │
  │   receipts)           │                                  │
```

Two components in the sample:

- `src/lib/translation-agent.ts` — `BaseAgent` subclass with a tool registry. Each tool entry declares its name, description, JSON schema, atomic-USDC `costAtomic`, an `args` validator, and an `execute` function. The agent owns the entire payment flow: phase 1 plans against all tools, validates every emitted call, sums costs, and gates if any paid tool is in the batch. Phase 2 verifies + settles the submission with the SDK's stateless helpers, executes every tool in order, and lets Claude compose the final summary. **Adding a new tool means one entry in `TOOLS` — no other code changes.**
- `src/lib/a2x-setup.ts` — wires the standard `AgentExecutor` with no payment options. The facilitator is injected into the agent constructor.

## Tools shipped in this sample

| Tool | Cost | What it does |
|---|---|---|
| `translate` | 0.01 USDC | Translate text into a target language (Anthropic). |
| `summarize` | 0.005 USDC | One-sentence summary of a passage (Anthropic). |
| `detect_language` | free | Detect what language a text is (Anthropic). |
| `word_count` | free | Count whitespace-separated words (no LLM, deterministic). |

## Setup

```bash
cp .env.example .env
# Required:
#   ANTHROPIC_API_KEY=sk-ant-...
# Required for real settlement:
#   X402_MERCHANT_ADDRESS=0xYourWallet
# Or, for fully local development without a wallet:
#   X402_MOCK_FACILITATOR=1

pnpm install
pnpm dev
```

The server listens on `http://localhost:3000` with:

- `GET /.well-known/agent.json` — AgentCard
- `POST /api/a2a` — JSON-RPC (`message/send`, `message/stream`, etc.)

## Calling it

### Free chat — Claude answers without any tool

```bash
a2x a2a send http://localhost:3000/api/a2a "what's the capital of france?"
```

Claude answers directly. No tool_use, no payment-required, no charge.

### Free tools only — no payment, no signature

```bash
a2x a2a send http://localhost:3000/api/a2a "how many words is 'the quick brown fox'?"
# Claude calls word_count (free) → "4 words"

a2x a2a send http://localhost:3000/api/a2a "what language is 'こんにちは'?"
# Claude calls detect_language (free) → "japanese"
```

Anthropic plan call is on the merchant; no x402 round-trip.

### Single paid tool — translate

```bash
a2x wallet create
a2x wallet use default
# Fund with Base Sepolia USDC: https://faucet.circle.com

a2x a2a send http://localhost:3000/api/a2a "translate 'hello, how are you?' to korean"
# Bill: translate = 0.01 USDC. Total = 0.01 USDC.
```

### Mixed batch — free + paid in one turn

```bash
a2x a2a send http://localhost:3000/api/a2a \
  "what language is 'bonjour' and translate it to spanish"
# Claude may call [detect_language, translate] in one response.
# Bill: detect_language = free, translate = 0.01 USDC. Total = 0.01 USDC.
# A single x402 round-trip covers the whole batch.
```

### Multiple paid tools — costs sum

```bash
a2x a2a send http://localhost:3000/api/a2a \
  "translate 'hello' to korean and summarize 'the quick brown fox jumps over the lazy dog'"
# Claude may call [translate, summarize] in one response.
# Bill: translate = 0.01 USDC, summarize = 0.005 USDC. Total = 0.015 USDC.
# Single payment covers both tools after settlement.
```

### Programmatic SDK usage

```ts
import { A2XClient } from '@a2x/sdk/client';
import { privateKeyToAccount } from 'viem/accounts';

const client = new A2XClient('http://localhost:3000/api/a2a', {
  x402: { signer: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`) },
});

// Free — Claude answers directly.
const free = await client.sendMessage({
  message: {
    messageId: crypto.randomUUID(),
    role: 'user',
    parts: [{ text: 'tell me a joke' }],
  },
});

// Premium — Claude picks one or more paid tools. A2XClient detects
// payment-required (yielded from inside the agent), signs, resubmits, settles.
const premium = await client.sendMessage({
  message: {
    messageId: crypto.randomUUID(),
    role: 'user',
    parts: [{ text: 'translate good morning to japanese' }],
  },
});
```

## Adding a new tool

Define a `ToolHandler` and add it to the `TOOLS` registry in `translation-agent.ts`:

```ts
const WEB_SEARCH: ToolHandler = {
  declaration: {
    name: 'web_search',
    description: 'Search the web for the given query.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query'],
    },
  },
  costAtomic: 20_000, // 0.02 USDC
  validate(args) {
    const a = args as Record<string, unknown>;
    if (typeof a.query !== 'string' || a.query.length === 0) {
      throw new Error('web_search.query must be a non-empty string');
    }
  },
  async execute(args, _deps) {
    // call your search backend here
    return await search((args as { query: string }).query);
  },
};

const TOOLS = { translate: TRANSLATE, summarize: SUMMARIZE, detect_language: DETECT_LANGUAGE, word_count: WORD_COUNT, web_search: WEB_SEARCH };
```

Update the system prompt to mention the new tool, and you're done. The dispatch logic, cost summing, validation, gating, and execution loop already handle it.

## What to tweak

- `TOOLS` registry in `src/lib/translation-agent.ts` — add or remove tools, adjust prices.
- `payment` in `src/lib/a2x-setup.ts` — adjust network, asset, merchant address. The agent constructs an `accept` per turn from this config plus the per-tool sum.
- Retry behavior — to re-issue `payment-required` after a verify/settle failure instead of terminating, yield `x402RequestPayment` again with `previousError` set from the agent's failure branch (see [migration guide](../../packages/a2x/docs/guides/advanced/migration-x402-v2.md#retry-on-failure)).
- `ANTHROPIC_MODEL` env var — pin a specific Claude model. Defaults to `claude-sonnet-4-20250514`.

## Caveats

- **Gating is per-turn, all-or-nothing.** When a batch contains one paid tool and several free tools, the entire batch is gated together. Free tools don't run before settlement either. This keeps the user-facing prompt simple ("you are paying for this turn"), at the cost of slightly more wait time on free tools that ride along.
- **Anthropic spend.** A paid turn does the planning call twice (first turn + resubmit), the per-paid-tool execution call(s), and the final summary call. For two paid tools that's ~5 Anthropic calls. Use `claude-haiku-*` or trim if cost matters.
- The agent gates the paid path on `parseX402PaymentSubmission(context.message)` and the planning result; the executor halts the generator on `request-input` so subsequent yields after a payment request are dropped.
- LLM outputs (translation, summary, language name) are non-deterministic. Don't rely on exact wording for tests.
