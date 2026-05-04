# Migrating from `X402PaymentExecutor` to the input-required surface

This guide is for projects on `@a2x/sdk` 0.x that use `X402PaymentExecutor`. SDK 1.x replaces the class with a smaller, agent-driven surface built on `request-input` AgentEvents. Wire format is unchanged — existing clients keep working without modification.

## What changed

| Item | 0.x | 1.x |
|---|---|---|
| Removed | `X402PaymentExecutor`, `X402PaymentExecutorOptions` | — |
| Added | — | `request-input` AgentEvent variant; `x402RequestPayment()`, `x402PaymentHook()`, `readX402Settlement()`, `X402_DOMAIN` (all from `@a2x/sdk` and `@a2x/sdk/x402`) |
| Where the "is this call paid?" predicate lives | Executor option `requiresPayment` | Inside `agent.run()` |
| Number of `extends` lines for x402 | 1 (`extends AgentExecutor` in custom case) | 0 |
| Wire metadata keys, status values, error codes | unchanged | unchanged |

The breaking change consists of exactly two removed exports: `X402PaymentExecutor` and `X402PaymentExecutorOptions`. The wire stays bit-for-bit identical.

## Step-by-step

### Always-paid (S1)

**Before**

```ts
import {
  AgentExecutor,
  X402PaymentExecutor,
  X402_EXTENSION_URI,
  BaseAgent,
} from '@a2x/sdk';

class EchoAgent extends BaseAgent {
  async *run(context) {
    yield { type: 'text', role: 'agent', text: 'pong' };
    yield { type: 'done' };
  }
}

const inner = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
});

const executor = new X402PaymentExecutor(inner, {
  accepts: ACCEPTS,
  facilitator: { url: process.env.X402_FACILITATOR_URL! },
});

export const agent = new A2XAgent({ taskStore, executor })
  .addExtension({ uri: X402_EXTENSION_URI, required: true });
```

**After**

```ts
import {
  AgentExecutor,
  BaseAgent,
  x402PaymentHook,
  x402RequestPayment,
  readX402Settlement,
  X402_EXTENSION_URI,
} from '@a2x/sdk';

class EchoAgent extends BaseAgent {
  async *run(context) {
    if (!readX402Settlement(context).paid) {
      yield* x402RequestPayment({ accepts: ACCEPTS });
      return;
    }
    yield { type: 'text', role: 'agent', text: 'pong' };
    yield { type: 'done' };
  }
}

const executor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
  inputRoundTripHooks: [
    x402PaymentHook({ facilitator: { url: process.env.X402_FACILITATOR_URL! } }),
  ],
});

export const agent = new A2XAgent({ taskStore, executor })
  .addExtension({ uri: X402_EXTENSION_URI, required: true });
```

The new code adds two lines to the agent (the `readX402Settlement` branch and the `x402RequestPayment` yield) and replaces the `X402PaymentExecutor` instantiation with a single `inputRoundTripHooks` option on the existing `AgentExecutor`.

### Conditional pricing (S2)

**Before**

```ts
function isPremiumRequest(message: Message): boolean {
  // ...
}

class TieredAgent extends BaseAgent {
  async *run(context) {
    const isPremium = isPremiumRequest(reconstructedMessage);  // <-- duplicate decision
    if (isPremium) yield { type: 'text', text: 'Premium ...' };
    else yield { type: 'text', text: 'Free ...' };
    yield { type: 'done' };
  }
}

new X402PaymentExecutor(inner, {
  accepts: PREMIUM_ACCEPTS,
  requiresPayment: isPremiumRequest,                       // <-- duplicate decision
});
```

The predicate had to be duplicated: once on the executor (to decide whether to gate) and once in the agent (to decide what to respond).

**After**

```ts
class TieredAgent extends BaseAgent {
  async *run(context) {
    const text = lastUserText(context);
    const isPremium = text.length > 100 || PREMIUM_KEYWORDS.some((k) => text.toLowerCase().includes(k));

    if (isPremium && !readX402Settlement(context).paid) {
      yield* x402RequestPayment({ accepts: PREMIUM_ACCEPTS });
      return;
    }

    yield { type: 'text', role: 'agent', text: isPremium ? 'Premium ...' : 'Free ...' };
    yield { type: 'done' };
  }
}

new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
  inputRoundTripHooks: [x402PaymentHook({ facilitator: ... })],
});
```

Single source of truth for the predicate. The `requiresPayment` option goes away.

### Agent-driven payment (S3)

**Before**

```ts
// payment-required-event.ts — sentinel MIME (~66 LOC, sample-side)
export const PAYMENT_REQUIRED_SENTINEL_MIME = '...';
export const PAYMENT_SETTLED_SESSION_KEY = '__x402_payment_settled';
export async function* yieldPaymentRequired(...) { ... }

// agent-driven-x402-executor.ts — custom AgentExecutor (~250+ LOC)
class AgentDrivenX402Executor extends AgentExecutor { ... }

// translation-agent.ts
const settled = context.state[PAYMENT_SETTLED_SESSION_KEY] === true;
if (!settled) {
  yield* yieldPaymentRequired({ ... });
  return;
}
yield* this._runDeepTranslate(...);
```

The pattern required a sentinel `data` event with a custom MIME type, a session-state hack, and a custom executor that intercepted the sentinel and ran verify/settle.

**After**

```ts
import { x402RequestPayment, readX402Settlement } from '@a2x/sdk';

class TranslationAgent extends BaseAgent {
  async *run(context) {
    const intent = classifyIntent(lastUserText(context));
    if (intent.kind === 'translate') {
      if (!readX402Settlement(context).paid) {
        yield* x402RequestPayment({
          accepts: [this._buildAccept()],
          description: `About to call deep_translate("${intent.text}")`,
        });
        return;
      }
      yield* this._runDeepTranslate(intent.text, intent.lang);
    }
    // ...
  }
}

const executor = new AgentExecutor({
  runner, runConfig: ...,
  inputRoundTripHooks: [x402PaymentHook({ facilitator: ... })],
});
```

The custom executor (~647 LOC in the original sample), the sentinel module (~66 LOC), and the session-state key all disappear. The agent uses exactly the same `x402RequestPayment` / `readX402Settlement` pair as the always-paid case.

## Behaviors that do NOT change

Any of the following keep working without modification:

- All wire metadata keys (`x402.payment.status`, `x402.payment.required`, `x402.payment.payload`, `x402.payment.receipts`, `x402.payment.error`).
- All payment status values (`payment-required`, `payment-submitted`, `payment-rejected`, `payment-verified`, `payment-completed`, `payment-failed`).
- All error codes (the seven from spec §9.1 plus the SDK-specific extensions).
- The full task lifecycle (input-required → submitted → verified → completed/failed).
- Facilitator URL config and custom `{ verify, settle }` injection — same shape, same path.
- `A2XClient` and every client-side primitive (`signX402Payment`, `getX402PaymentRequirements`, `getX402Receipts`, `rejectX402Payment`).
- AgentCard extension activation (`addExtension({ uri: X402_EXTENSION_URI, required: true })`).
- The `retryOnFailure` semantics (now an option on `x402PaymentHook` instead of the executor).

## Compile errors you'll see

Searching for these strings in your codebase shows every place that needs updating:

```
import { X402PaymentExecutor } from '@a2x/sdk';
import type { X402PaymentExecutorOptions } from '@a2x/sdk';
```

Both produce `Module has no exported member ...`. The fix is the 1:1 mapping above.

## Codemod

There isn't one — by design. The decision of *where* to put your "is this call paid?" predicate is a design choice the SDK can't safely automate (the answer depends on whether you also need to vary the agent's response, on what session/state you have, etc.). The mapping is mechanical enough that grep + the diffs above takes 5–10 minutes per project.

## Reference

- [x402 Payments overview](./x402-payments.md) — the full guide for the new surface.
- [Spec a2a-x402 v0.2](https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2.md)
- Sample diffs: `samples/nextjs-x402` (all-paid), `samples/nextjs-x402-agent-driven` (LLM tool-use-driven).
