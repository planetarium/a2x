# Migrating off `x402PaymentHook` to the helper-only surface

This guide is for projects on `@a2x/sdk` 0.13.x that use `x402PaymentHook` / `inputRoundTripHooks` / `readX402Settlement`. The next release removes the SDK-owned payment *flow* and ships only stateless helpers — agents own the entire payment lifecycle inside `BaseAgent.run()`.

**The wire format is unchanged.** All `x402.payment.*` metadata keys, status values, and error codes are bit-for-bit identical. Existing A2A clients keep working without modification. The breaking change is server-side authoring only.

## Why

`x402PaymentHook` persisted bookkeeping under `_a2x.inputRoundTrip` inside `task.status.message.metadata` and ran verify+settle on the SDK's schedule. That had three issues (see [issue #162](https://github.com/planetarium/a2x/issues/162)):

- **Wire leak.** SDK-internal bookkeeping shipped to every client on every `input-required` response, every `tasks/get`, and every push notification.
- **Flow ownership in the wrong place.** The merchant — not the SDK — is the authority on what was offered, how to validate, what to do between `verify` and `settle`, and whether to retry. The SDK couldn't represent the merchant's business rules without growing options for every case.
- **Bundled verify+settle.** The hook didn't expose a hook point between the two steps. Audit logging, fraud checks, reward pre-allocation between verify and settle weren't expressible without forking the SDK.

The new design removes the flow entirely. The SDK ships **stateless helpers** the agent composes inside `run()` — every step is its own function, callable in any order, with any user logic inserted in between.

## What changed

| Item | 0.13.x | Next |
|---|---|---|
| Removed | `x402PaymentHook`, `readX402Settlement`, `X402_DOMAIN`, `InputRoundTripRecord`, `InputRoundTripHook`, `InputRoundTripOutcome`, `InputRoundTripContext`, `INPUT_ROUNDTRIP_METADATA_KEY`, `inputRoundTripHooks` (`AgentExecutorOptions`) | — |
| Added (recommended façade) | — | `X402Context`, `X402Store`, `InMemoryX402Store`, `X402Classification` |
| Added (low-level helpers) | — | `parseX402PaymentSubmission`, `pickX402Requirement`, `validateX402PayloadShape`, `normalizeX402Accept`, `buildX402PaymentRequiredMetadata`, `buildX402PaymentCompletedMetadata`, `buildX402PaymentFailedMetadata`, `buildX402PaymentVerifiedMetadata`; `metadata?` on `done` / `error` AgentEvents; `message` on `InvocationContext` |
| Changed | `request-input` event had `domain` + `payload` fields | `request-input` event has only `metadata` + optional `message` |
| Where verify+settle runs | Inside `x402PaymentHook.handleResume` | Inside `agent.run()` — `x402.verify(...)` and `x402.settle(...)` (or `facilitator.verify/settle` for the low-level path) |
| Where "what was offered" is stored | Inside the task's metadata as `_a2x.inputRoundTrip.payload` (wire-visible) | In an `X402Store` (in-memory by default, pluggable) keyed by `context.taskId` — never on the wire |
| Wire metadata keys, status values, error codes | unchanged | unchanged |

## Step-by-step

### Always-paid

**Before (0.13.x):**

```ts
import {
  AgentExecutor, BaseAgent, X402_EXTENSION_URI,
  x402PaymentHook, x402RequestPayment, readX402Settlement,
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
  inputRoundTripHooks: [x402PaymentHook({ facilitator: { url: process.env.X402_FACILITATOR_URL! } })],
});
```

**After (recommended — uses `X402Context`):**

```ts
import { AgentExecutor, BaseAgent } from '@a2x/sdk';
import { X402Context, X402_EXTENSION_URI } from '@a2x/sdk/x402';

class EchoAgent extends BaseAgent {
  constructor(private readonly x402: X402Context) {
    super({ name: 'echo' });
  }

  async *run(ctx) {
    const result = await this.x402.classify(ctx);

    switch (result.kind) {
      case 'no-submission':
        yield* this.x402.requestPayment(ctx, {
          accepts: ACCEPTS,
          expiresInSeconds: 600,
        });
        return;
      case 'rejected':
      case 'no-stored-offering':
      case 'unmatched':
      case 'invalid-shape':
        yield this.x402.failedEvent({ code: result.code, reason: result.reason });
        return;
      case 'valid':
        break;
    }

    const verify = await this.x402.verify(ctx, result);
    if (!verify.isValid) {
      yield this.x402.failedEvent({
        code: 'VERIFY_FAILED',
        reason: verify.invalidReason ?? 'Payment verification failed.',
      });
      return;
    }

    // [insert any custom logic between verify and settle]

    const receipt = await this.x402.settle(ctx, result);
    if (!receipt.success) {
      yield this.x402.failedEvent({
        code: 'SETTLEMENT_FAILED',
        reason: receipt.errorReason ?? 'Payment settlement failed.',
        failureReceipt: receipt,
      });
      return;
    }

    await this.x402.clearOffering(ctx);
    yield { type: 'text', role: 'agent', text: 'pong' };
    yield this.x402.completedEvent({ receipt });
  }
}

const x402 = new X402Context({
  facilitator: process.env.X402_FACILITATOR_URL
    ? { url: process.env.X402_FACILITATOR_URL }
    : undefined,
});

const executor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
  // No payment options. The agent owns the flow via X402Context.
});
```

`X402Context` is one new import that replaces the hook + a handful of helpers. It pairs the offering store (was implicit in the old `_a2x.inputRoundTrip` stash, now an explicit pluggable `X402Store`) with the facilitator and the event builders. The lower-level helpers (`parseX402PaymentSubmission`, `pickX402Requirement`, …) are still exported for callers that want full bespoke control.

### Retry on failure

**Before:** `x402PaymentHook({ retryOnFailure: true })`.

**After:** yield `requestPayment` again from the failure branch — the offering store is re-populated with the new accepts:

```ts
if (!verify.isValid) {
  yield* this.x402.requestPayment(ctx, {
    accepts: ACCEPTS,
    previousError: verify.invalidReason,
    expiresInSeconds: 600,
  });
  return;
}
```

### Variable / per-task pricing

**Before:** the SDK re-derived the requirement from `_a2x.inputRoundTrip.payload.accepts` on resume.

**After:** `X402Context` already persists per-task offerings keyed by `ctx.taskId` in its `store`. Hand it dynamic `accepts` and it remembers them for the resume turn:

```ts
async *run(ctx) {
  const result = await this.x402.classify(ctx);
  if (result.kind === 'no-submission') {
    const accepts = await this.pricing.quoteFor(ctx.message!, ctx.taskId!);
    yield* this.x402.requestPayment(ctx, { accepts, expiresInSeconds: 600 });
    return;
  }
  // ...
}
```

For production deployments that need offering state to survive restarts, plug an external store implementing `X402Store` (Postgres / Redis / Durable Object / …).

### Detecting client rejection

**Before:** `x402PaymentHook` auto-handled `payment-rejected` and terminated the task.

**After:** `X402Context.classify(...)` returns `{ kind: 'rejected', ... }` — handle that case in the same `switch` you already have. If you're using the low-level helpers directly, check the submission status:

```ts
const submission = parseX402PaymentSubmission(context.message!);
if (submission?.status === X402_PAYMENT_STATUS.REJECTED) {
  yield {
    type: 'error',
    error: new Error('Client declined.'),
    metadata: buildX402PaymentFailedMetadata({
      code: X402_ERROR_CODES.INVALID_PAYLOAD,
      reason: 'Client declined to pay.',
    }),
  };
  return;
}
```

### Reading the user's original message on the resume turn

**Before:** `lastUserText(context)` walked `context.session.events` (which only contains the resume message on turn 2).

**After:** the original message's `parts` and `metadata` are now on `context.message` on every turn — the client preserves the original parts when it submits the signed payment, so reading them straight off `context.message.parts` works.

## Behaviors that do NOT change

- Every `x402.payment.*` metadata key.
- Every payment status value (`payment-required` / `submitted` / `rejected` / `verified` / `completed` / `failed`).
- Every error code (seven from spec §9.1 plus the SDK-specific extensions).
- The full task lifecycle on the wire.
- Facilitator URL config and custom `{ verify, settle }` injection.
- `A2XClient` and every client-side primitive (`signX402Payment`, `getX402PaymentRequirements`, `getX402Receipts`, `rejectX402Payment`).
- AgentCard extension activation (`addExtension({ uri: X402_EXTENSION_URI, required: true })`).
- `X-A2A-Extensions` header enforcement (`DefaultRequestHandler`).

## Import path change

x402 is no longer re-exported from the main entry. Every x402 name now imports from the dedicated `@a2x/sdk/x402` subpath:

```ts
// Before
import { X402_EXTENSION_URI, signX402Payment, ... } from '@a2x/sdk';

// After
import { X402_EXTENSION_URI, signX402Payment, ... } from '@a2x/sdk/x402';
```

This split lets non-payment agents skip the `x402` / `viem` peer-dependency install entirely. `A2XClientX402Options` (the type for `A2XClient`'s `x402` constructor option) stays on the main entry — it's a client-config type, not an x402-feature import.

## Compile errors you'll see

Search for these strings — every match needs updating:

```
import { x402PaymentHook }       from '@a2x/sdk';     // removed (use @a2x/sdk/x402)
import { readX402Settlement }    from '@a2x/sdk';     // removed
import { X402_DOMAIN }           from '@a2x/sdk';     // removed
import type { InputRoundTrip... } from '@a2x/sdk';    // removed
import { X402_EXTENSION_URI }    from '@a2x/sdk';     // moved to @a2x/sdk/x402
import { signX402Payment }       from '@a2x/sdk';     // moved to @a2x/sdk/x402
import { getX402Receipts }       from '@a2x/sdk';     // moved to @a2x/sdk/x402
inputRoundTripHooks: [...]                            // removed AgentExecutorOptions field
event.domain                                          // removed from request-input
event.payload                                         // removed from request-input
context.input                                         // removed from InvocationContext (use context.message)
```

## Codemod

There isn't one. The shape of the new code depends on:

- whether your prior agent body branched on `readX402Settlement(context).paid`,
- whether you used `retryOnFailure: true`,
- what business logic (if any) you'd like between `verify` and `settle`,
- whether your offering is constant or task-keyed.

The 0.13.x → next migration is mechanical for any *single* shape but the cross-product isn't, and the SDK can't safely autoresolve the differences. Use the always-paid example above as the template; adapt the conditional / variable-pricing / retry pieces by hand.

## Reference

- [x402 Payments overview](./x402-payments.md) — the full guide for the new surface.
- [Spec a2a-x402 v0.2](https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2.md)
- [Issue #162](https://github.com/planetarium/a2x/issues/162) — the design discussion that motivated this change.
- Sample diffs: `samples/nextjs-x402` (always-paid), `samples/nextjs-x402-agent-driven` (LLM tool-use-driven).
