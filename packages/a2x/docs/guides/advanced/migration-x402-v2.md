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
| Added | — | `parseX402PaymentSubmission`, `pickX402Requirement`, `validateX402PayloadShape`, `normalizeX402Accept`, `buildX402PaymentRequiredMetadata`, `buildX402PaymentCompletedMetadata`, `buildX402PaymentFailedMetadata`, `buildX402PaymentVerifiedMetadata`; `metadata?` on `done` / `error` AgentEvents; `message` on `InvocationContext` |
| Changed | `request-input` event had `domain` + `payload` fields | `request-input` event has only `metadata` + optional `message` |
| Where verify+settle runs | Inside `x402PaymentHook.handleResume` | Inside `agent.run()` — `facilitator.verify()` and `facilitator.settle()` called directly |
| Where "what was offered" is stored | Inside the task's metadata as `_a2x.inputRoundTrip.payload` | The merchant's own durable store (or constants), keyed by `context.taskId` |
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

**After:**

```ts
import {
  AgentExecutor, BaseAgent, X402_EXTENSION_URI, X402_ERROR_CODES, X402_PAYMENT_STATUS,
  buildX402PaymentCompletedMetadata, buildX402PaymentFailedMetadata,
  mapVerifyFailureToCode, normalizeX402Accept, parseX402PaymentSubmission,
  pickX402Requirement, resolveFacilitator, validateX402PayloadShape, x402RequestPayment,
  type X402Facilitator,
} from '@a2x/sdk';

class EchoAgent extends BaseAgent {
  constructor(private readonly facilitator: X402Facilitator) {
    super({ name: 'echo' });
  }

  async *run(context) {
    const submission = parseX402PaymentSubmission(context.message!);

    // Turn 1
    if (!submission) {
      yield* x402RequestPayment({ accepts: ACCEPTS });
      return;
    }

    // Client declined
    if (submission.status !== X402_PAYMENT_STATUS.SUBMITTED || !submission.payload) {
      yield {
        type: 'error',
        error: new Error('Payment not submitted.'),
        metadata: buildX402PaymentFailedMetadata({
          code: X402_ERROR_CODES.INVALID_PAYLOAD, reason: 'Payment not submitted.',
        }),
      };
      return;
    }

    // Match + validate locally
    const requirements = ACCEPTS.map(normalizeX402Accept);
    const requirement = pickX402Requirement(submission.payload, requirements);
    if (!requirement) {
      yield {
        type: 'error',
        error: new Error('No matching requirement.'),
        metadata: buildX402PaymentFailedMetadata({
          code: X402_ERROR_CODES.NETWORK_MISMATCH, reason: 'Submitted option not offered.',
        }),
      };
      return;
    }
    const issues = validateX402PayloadShape(submission.payload, requirement);
    if (issues.length > 0) {
      const first = issues[0]!;
      yield {
        type: 'error',
        error: new Error(first.reason),
        metadata: buildX402PaymentFailedMetadata({ code: first.code, reason: first.reason }),
      };
      return;
    }

    // Verify
    const verify = await this.facilitator.verify(submission.payload, requirement);
    if (!verify.isValid) {
      yield {
        type: 'error',
        error: new Error(verify.invalidReason ?? 'verify failed'),
        metadata: buildX402PaymentFailedMetadata({
          code: mapVerifyFailureToCode(verify.invalidReason),
          reason: verify.invalidReason ?? 'Verification failed.',
        }),
      };
      return;
    }

    // [insert any custom logic between verify and settle]

    // Settle
    const settle = await this.facilitator.settle(submission.payload, requirement);
    if (!settle.success) {
      yield {
        type: 'error',
        error: new Error(settle.errorReason ?? 'settle failed'),
        metadata: buildX402PaymentFailedMetadata({
          code: X402_ERROR_CODES.SETTLEMENT_FAILED,
          reason: settle.errorReason ?? 'Settlement failed.',
        }),
      };
      return;
    }

    yield { type: 'text', role: 'agent', text: 'pong' };
    yield {
      type: 'done',
      metadata: buildX402PaymentCompletedMetadata({
        receipt: {
          success: true,
          transaction: settle.transaction ?? '',
          network: submission.payload.network,
          payer: submission.authorization?.from ?? settle.payer ?? 'unknown',
        },
      }),
    };
  }
}

const facilitator = process.env.X402_FACILITATOR_URL
  ? resolveFacilitator({ url: process.env.X402_FACILITATOR_URL })
  : resolveFacilitator();

const executor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
  // No inputRoundTripHooks. The agent owns the flow.
});
```

Longer, yes — but every step is now visible at the call site and interceptable.

### Retry on failure

**Before:** `x402PaymentHook({ retryOnFailure: true })`.

**After:** simply yield `x402RequestPayment` again from the failure branch:

```ts
if (!verify.isValid) {
  yield* x402RequestPayment({
    accepts: ACCEPTS,
    previousError: verify.invalidReason,
  });
  return;
}
```

### Variable / per-task pricing

**Before:** the SDK re-derived the requirement from `_a2x.inputRoundTrip.payload.accepts` on resume.

**After:** the merchant persists what it offered, keyed by `context.taskId`:

```ts
async *run(context) {
  const submission = parseX402PaymentSubmission(context.message!);

  if (!submission) {
    const accepts = await this.pricing.quoteFor(context.message!, context.taskId!);
    await this.db.put(context.taskId!, accepts);          // remember it
    yield* x402RequestPayment({ accepts });
    return;
  }

  const accepts = await this.db.get(context.taskId!);      // recover it
  // ... validate, verify, settle ...
}
```

The merchant has every reason to store this anyway (audit logs, A/B tests, pricing rules).

### Detecting client rejection

**Before:** `x402PaymentHook` auto-handled `payment-rejected` and terminated the task.

**After:** the agent checks the submission status:

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

## Compile errors you'll see

Search for these strings — every match needs updating:

```
import { x402PaymentHook }       from '@a2x/sdk';   // removed
import { readX402Settlement }    from '@a2x/sdk';   // removed
import { X402_DOMAIN }           from '@a2x/sdk';   // removed
import type { InputRoundTrip... } from '@a2x/sdk';  // removed
inputRoundTripHooks: [...]                          // removed AgentExecutorOptions field
event.domain                                        // removed from request-input
event.payload                                       // removed from request-input
context.input                                       // removed from InvocationContext (use context.message)
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
