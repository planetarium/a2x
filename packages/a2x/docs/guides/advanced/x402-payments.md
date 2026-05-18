# x402 Payments

Charge per call with on-chain cryptocurrency payments. A2X implements the [a2a-x402 v0.2](https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2.md) extension, which layers the [x402 payment protocol](https://x402.org) on top of A2A tasks.

The flow: the merchant agent responds to an unpaid request with `input-required` + `x402.payment.required`. The client signs a `PaymentPayload` with its wallet and resubmits the same task. The merchant validates the payload, verifies it via an x402 **facilitator**, settles on-chain, and attaches the settlement receipt to the completed task.

> **What changed in this release.** The SDK no longer ships a payment *flow* — only stateless helpers. The agent owns when to request payment, what was offered, how to validate the submission, whether to retry, and what to do between `verify` and `settle`. The previous `x402PaymentHook` / `inputRoundTripHooks` API is removed; see [Migrating from X402PaymentExecutor / x402PaymentHook](./migration-x402-v2.md) for the migration steps.

## Installation

```bash
pnpm add @a2x/sdk x402 viem
```

`x402` and `viem` are **optional peer dependencies** — only install them if you actually enable x402 on your agent or client. The SDK lazy-loads the `x402` runtime helpers on the first call to `signX402Payment` (or the first time `A2XClient.sendMessage` enters the dance), so non-x402 consumers can omit the dep without breaking bundlers.

## Server

The agent owns the full payment flow. The recommended way to write x402 agents is to instantiate an `X402Context` once, pass it into the agent, and dispatch on `classify(ctx)` inside `run()`. The context bundles three pieces every x402 agent needs together:

- an **offering store** that remembers what was advertised for each `taskId` (so the resume turn validates against the right requirement),
- a **facilitator** that runs on-chain verify + settle,
- **event builders** that produce the right wire metadata for each terminal state.

No method bundles `verify` + `settle` — they stay separate so the agent can do anything between them (audit logs, fraud checks, reward pre-allocation, …).

```ts
import {
  A2XAgent,
  AgentExecutor,
  BaseAgent,
  StreamingMode,
  InMemoryRunner,
  InMemoryTaskStore,
} from '@a2x/sdk';
import {
  X402Context,
  X402_EXTENSION_URI,
  X402_ERROR_CODES,
} from '@a2x/sdk/x402';

const ACCEPTS = [{
  network: 'base-sepolia',
  amount: '10000',                                       // 0.01 USDC (6 decimals)
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',   // USDC on Base Sepolia
  payTo: process.env.MERCHANT_ADDRESS!,
  resource: 'https://api.example.com/premium',
  description: 'Premium agent access',
}];

class PaidAgent extends BaseAgent {
// One context per process is enough — pass it into every agent that
// needs x402 support. Defaults to an in-memory offering store and the
// Coinbase-hosted facilitator at https://x402.org/facilitator.
const x402 = new X402Context();

class PaidAgent extends BaseAgent {
  constructor(private readonly x402: X402Context) {
    super({ name: 'paid_agent', description: 'Charges per call.' });
  }

  async *run(ctx) {
    const result = await this.x402.classify(ctx);

    switch (result.kind) {
      case 'no-submission':
        // Turn 1 — store the offering, yield request-input. 10-minute TTL.
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

    // verify → custom logic → settle → custom logic. Each step is exposed
    // independently so you can record audit logs, run fraud checks, or
    // pre-allocate downstream resources between them.
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
    yield { type: 'text', role: 'agent', text: 'thanks for paying' };
    yield this.x402.completedEvent({ receipt });
  }
}

const runner = new InMemoryRunner({ agent: new PaidAgent(x402), appName: 'paid-agent' });
const executor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
});

const agent = new A2XAgent({ taskStore: new InMemoryTaskStore(), executor })
  .setName('Paid Agent')
  .setDescription('Charges per call')
  .addExtension({ uri: X402_EXTENSION_URI, required: true });
```

### `X402Context` API

| Member | What it does |
|---|---|
| `new X402Context({ store?, facilitator? })` | Construct once. `store` defaults to `new InMemoryX402Store()`. `facilitator` accepts a `FacilitatorUrlConfig`, a custom `X402Facilitator` impl, or `undefined` (defaults to `https://x402.org/facilitator`). |
| `x402.requestPayment(ctx, { accepts, description?, previousError?, expiresInSeconds? })` | Async generator. Persists the offering keyed by `ctx.taskId` (with optional TTL) and yields the `request-input` event. |
| `x402.classify(ctx)` | Returns a tagged union: `'no-submission'`, `'rejected'`, `'no-stored-offering'`, `'unmatched'`, `'invalid-shape'`, or `'valid'`. Switch on `kind` to decide what to do. |
| `x402.verify(ctx, classified)` | Calls `facilitator.verify(...)`. Records `status: 'verified'` on success, or `status: 'failed'` with `failure.point: 'verify'` on failure. |
| `x402.settle(ctx, classified)` | Calls `facilitator.settle(...)` and returns a wire-conformant `X402SettleResponse`. Records `status: 'completed'` + the trimmed receipt on success, or `status: 'failed'` with `failure.point: 'settle'` on failure. |
| `x402.failedEvent({ code, reason, failureReceipt?, priorReceipts? })` | Builds an `error` `AgentEvent` with `payment-failed` metadata attached. Does NOT touch the store (already recorded by `classify` / `verify` / `settle`). |
| `x402.completedEvent({ receipt, priorReceipts? })` | Builds a `done` `AgentEvent` with `payment-completed` metadata attached. |
| `x402.clearOffering(ctx)` | Remove the lifecycle record after a task terminates. Best-effort; no-op if absent. |
| `x402.store`, `x402.facilitator` | Direct access for advanced callers (e.g. inspect the raw verify response, or read back the recorded entry). |

### Lifecycle status tracking

Every method above updates `X402StoreEntry.status` automatically as the round-trip progresses. The agent never has to call `store.update` directly. The state machine:

```
requestPayment  →  offered
classify        →  (no change on 'valid', records 'failed' / 'rejected' otherwise)
verify          →  verified  (on success)
                →  failed + failure.point='verify'  (on isValid=false)
settle          →  completed + receipt  (on success)
                →  failed + failure.point='settle'  (on success=false)
```

The entry retains:

- `accepts` — what was offered on turn 1 (immutable)
- `status` — current lifecycle stage
- `storedAt` / `updatedAt` — timestamps
- `expiresAt` — TTL (if set on `requestPayment`)
- `verifiedAt` — populated once `status` reaches `verified`
- `receipt` — populated once `status === 'completed'`. Trimmed to `{ transaction, network, payer, settledAt }`
- `failure` — populated once `status === 'failed'` or `'rejected'`. Contains `{ point, code, reason, failedAt }`

`failure.point` identifies where the round-trip broke:

| `point` value | When |
|---|---|
| `'classify'` | Submission was invalid before facilitator was called (no offering / unmatched / shape error) |
| `'verify'` | `facilitator.verify` returned `isValid: false` |
| `'settle'` | `facilitator.settle` returned `success: false` |
| `'rejected-by-client'` | Client sent `x402.payment.status: payment-rejected` |

Read the entry back any time for audit / reconciliation:

```ts
const entry = await x402.store.get(taskId);
if (entry?.status === 'completed') {
  console.log('tx:', entry.receipt!.transaction, 'payer:', entry.receipt!.payer);
} else if (entry?.status === 'failed') {
  console.log('failed at', entry.failure!.point, '-', entry.failure!.reason);
}
```

### Pluggable offering store

`InMemoryX402Store` is fine for single-instance deployments. It is **not** suitable for:

- **horizontally scaled deployments** — each instance has its own memory, so the resume turn may hit a different instance with no offering record;
- **deployments that need offerings to survive process restarts**.

For either case, subclass `BaseX402Store` with a shared external backend (Redis / Postgres / Durable Object / …):

```ts
import { BaseX402Store, type X402StoreEntry, type X402StoreEntryPatch } from '@a2x/sdk/x402';

class RedisX402Store extends BaseX402Store {
  constructor(private readonly redis: Redis) { super(); }

  async put(entry: X402StoreEntry): Promise<void> {
    const ttl = entry.expiresAt
      ? Math.max(1, Math.ceil((entry.expiresAt.getTime() - Date.now()) / 1000))
      : undefined;
    await this.redis.set(
      `x402:${entry.taskId}`,
      JSON.stringify(entry),
      ttl ? { EX: ttl } : {},
    );
  }

  async get(taskId: string): Promise<X402StoreEntry | undefined> {
    const raw = await this.redis.get(`x402:${taskId}`);
    if (!raw) return undefined;
    // (in your impl: rehydrate Date fields from ISO strings)
    return JSON.parse(raw) as X402StoreEntry;
  }

  async update(taskId: string, patch: X402StoreEntryPatch): Promise<void> {
    const cur = await this.get(taskId);
    if (!cur) return;
    await this.put({ ...cur, ...patch, updatedAt: new Date() });
  }

  async delete(taskId: string): Promise<void> {
    await this.redis.del(`x402:${taskId}`);
  }
}

const x402 = new X402Context({ store: new RedisX402Store(redis) });
```

Lazy expiry contract: `get(taskId)` MUST return `undefined` after `entry.expiresAt`. Backends with native TTL (Redis `EXPIRE`, Postgres `WHERE expires_at > now()`) satisfy this trivially; in-memory or file-backed stores must check on read. No background reaper required — works in serverless deployments.

`InMemoryX402Store` also accepts `{ maxEntries }` for LRU eviction when the cap is reached.

### Subclassing `BaseX402Context`

Most callers instantiate `X402Context` and pass it around. When you need to override a step — wrap `verify` / `settle` with telemetry, customize `classify` validation, change the event-builder metadata shape — subclass `BaseX402Context` directly:

```ts
import { BaseX402Context, BaseX402Store, InMemoryX402Store, resolveFacilitator } from '@a2x/sdk/x402';

class TelemetryContext extends BaseX402Context {
  readonly store: BaseX402Store = new InMemoryX402Store();
  readonly facilitator = resolveFacilitator();

  async verify(payload, requirement) {
    const start = Date.now();
    try {
      return await super.verify(payload, requirement);
    } finally {
      metrics.histogram('x402.verify.duration_ms', Date.now() - start);
    }
  }

  async settle(submission, requirement) {
    const receipt = await super.settle(submission, requirement);
    auditLog.write({ kind: 'x402.settle', taskId: submission.payload?.network, receipt });
    return receipt;
  }
}
```

`BaseX402Context` provides concrete implementations for every method, so subclasses only override what they need. `X402Context` is itself a minimal subclass that fills in `store` + `facilitator` defaults; you can model your subclass the same way.

### Advanced: stateless helpers without `X402Context`

The low-level helpers `X402Context` is built on remain exported. Reach for them when you want full bespoke control — multiple facilitators, per-request store routing, or a hot-path that bypasses the context's payer-fallback in `settle`:

| Helper | One step it does |
|---|---|
| `x402RequestPayment(input)` | Generator that yields the `request-input` event. Does NOT store anything. |
| `buildX402PaymentRequiredMetadata(input)` | Same metadata, returned as a plain object. |
| `parseX402PaymentSubmission(message)` | Read the x402 status / payload / authorization fields off an incoming message. |
| `pickX402Requirement(payload, requirements)` | Find the requirement matching the submitted payload's network + scheme. |
| `validateX402PayloadShape(payload, requirement)` | Local checks; returns an array of issues. |
| `normalizeX402Accept(accept)` | Convert your offering shape to the spec's `X402PaymentRequirements`. |
| `mapVerifyFailureToCode(reason)` | Translate a facilitator's `invalidReason` to a spec §9.1 error code. |
| `resolveFacilitator(config?)` | Build the `{ verify, settle }` adapter from a URL or custom object. |
| `buildX402PaymentCompletedMetadata({ receipt, priorReceipts? })` | Final-message metadata for a successful payment. |
| `buildX402PaymentFailedMetadata({ code, reason, failureReceipt?, priorReceipts? })` | Final-message metadata for a failed payment. |
| `buildX402PaymentVerifiedMetadata()` | Intermediate `payment-verified` metadata for streaming (spec §7.1). |

No helper bundles `verify` + `settle`. Call `facilitator.verify(...)` and `facilitator.settle(...)` directly, with any custom logic in between.

### Multiple payment options

Put more than one entry in `accepts[]` and the client picks one. Use this for multi-network support:

```ts
const RESOURCE = 'https://api.example.com/premium';
const ACCEPTS = [
  { network: 'base-sepolia', amount: '10000', asset: USDC_BASE_SEPOLIA, payTo, resource: RESOURCE, description: 'Testnet' },
  { network: 'base',         amount: '10000', asset: USDC_BASE,         payTo, resource: RESOURCE, description: 'Mainnet' },
];
```

### Conditional pricing

The "is this call paid?" decision lives in `agent.run()`. Inspect anything you need — message content, headers, session state, an external policy service — and either yield `x402RequestPayment(...)` or proceed for free.

```ts
class TieredAgent extends BaseAgent {
  async *run(context) {
    const text = userText(context.message!);
    const submitted = parseX402PaymentSubmission(context.message!);
    const isPremium = text.length > 100 || PREMIUM_KEYWORDS.some((k) => text.includes(k));

    if (isPremium && !submitted) {
      yield* x402RequestPayment({ accepts: PREMIUM_ACCEPTS });
      return;
    }

    // ... if submitted, run the verify/settle dance using the helpers ...
    yield { type: 'text', role: 'agent', text: isPremium ? 'Premium ...' : 'Free ...' };
    yield { type: 'done' };
  }
}
```

### Storing offerings per task

For a single-merchant constant-bill agent you can re-derive the requirement on the resume turn (as the example above does). For per-task or per-user pricing, persist what you advertised on turn 1 and look it up on turn 2:

```ts
class DynamicPricingAgent extends BaseAgent {
  constructor(private readonly db: OfferingStore, private readonly facilitator: X402Facilitator) {
    super({ name: 'pricing_agent' });
  }

  async *run(context) {
    const submitted = parseX402PaymentSubmission(context.message!);

    if (!submitted) {
      const accepts = await this.priceFor(context.message!, context.taskId!);
      await this.db.put(context.taskId!, accepts);                  // remember what we offered
      yield* x402RequestPayment({ accepts });
      return;
    }

    const accepts = await this.db.get(context.taskId!);             // recover offering
    if (!accepts) { /* fail — no record of an offer for this task */ }
    const requirement = pickX402Requirement(submitted.payload!, accepts.map(normalizeX402Accept));
    // ... validate, verify, settle ...
  }
}
```

The SDK never persists offerings — the merchant has every reason to (audit logs, pricing rules, A/B tests, …), so the merchant owns the store.

### Retrying after failure

There's no SDK flag for this — the agent decides. To retry, simply yield `x402RequestPayment` again with the same accepts and the failure reason embedded:

```ts
const verify = await this.facilitator.verify(payload, requirement);
if (!verify.isValid) {
  yield* x402RequestPayment({
    accepts: ACCEPTS,
    previousError: verify.invalidReason ?? 'Verification failed.',
  });
  return;
}
```

To terminate instead, yield `{ type: 'error', metadata: buildX402PaymentFailedMetadata(...) }`. Both are one-line decisions in the agent body — no flag to flip on a hook.

### Streaming the intermediate `payment-verified` state

When you want clients to see the verified-but-not-yet-settled state in streaming responses, yield a text event between `verify` and `settle` carrying the intermediate metadata, or expose your own helper that the SDK already provides as `buildX402PaymentVerifiedMetadata()`:

```ts
// (between verify and settle)
yield {
  type: 'text',
  role: 'agent',
  text: '',
  // Note: today this event type doesn't carry metadata; if you need the
  // verified intermediate state on the wire as a separate streaming event,
  // open an issue describing the use case and we'll surface a primitive.
};
```

### Custom facilitator

For self-hosted facilitators or tests, pass a `{ verify, settle }` pair to the agent directly:

```ts
const facilitator = {
  async verify(payload, requirements) { /* … */ return { isValid: true }; },
  async settle(payload, requirements) {
    return { success: true, transaction: '0x…', network: 'base-sepolia', payer: '0x…' };
  },
};
new PaidAgent(facilitator);
```

### What gets emitted

On an unpaid request, the task transitions to `input-required` and the status message carries:

```json
{
  "x402.payment.status": "payment-required",
  "x402.payment.required": {
    "x402Version": 1,
    "accepts": [ /* PaymentRequirements[] */ ]
  }
}
```

On a successful payment, the completed task's status message carries:

```json
{
  "x402.payment.status": "payment-completed",
  "x402.payment.receipts": [
    {
      "success": true,
      "transaction": "0x…",
      "network": "base-sepolia",
      "payer": "0x857b06519E91e3A54538791bDbb0E22373e36b66"
    }
  ]
}
```

Every receipt carries a `payer` field per x402-v1 §5.3.2. Failures surface under `x402.payment.error` with one of the codes below.

| Code | Source | Meaning |
|---|---|---|
| `INSUFFICIENT_FUNDS` | spec §9.1 | Wallet can't cover the payment. |
| `INVALID_SIGNATURE` | spec §9.1 | Authorization signature failed verification. |
| `EXPIRED_PAYMENT` | spec §9.1 | Authorization was submitted after its validity window. |
| `DUPLICATE_NONCE` | spec §9.1 | Nonce has already been spent. |
| `NETWORK_MISMATCH` | spec §9.1 | Payload's network doesn't match any advertised `accepts`. |
| `INVALID_AMOUNT` | spec §9.1 | Authorization value doesn't match the required amount. |
| `SETTLEMENT_FAILED` | spec §9.1 | On-chain settle call failed. |
| `invalid_x402_version` | x402-v1 §6 / §9 | Merchant published a non-1 `x402Version`. |
| `INVALID_PAYLOAD` | SDK | Payment payload is missing or structurally invalid. |
| `INVALID_PAY_TO` | SDK | Authorization target address doesn't match `payTo`. |
| `VERIFY_FAILED` | SDK | Facilitator rejected the signature but the reason didn't match any spec code. |

Use `mapVerifyFailureToCode(verify.invalidReason)` to map free-form facilitator reasons into the spec codes.

### Payment lifecycle

Every paid task runs through the same state machine (spec §7.1):

```
PAYMENT_REQUIRED → PAYMENT_REJECTED            (client declined the challenge)
PAYMENT_REQUIRED → PAYMENT_SUBMITTED           (client signed and resubmitted)
PAYMENT_SUBMITTED → PAYMENT_VERIFIED           (facilitator verified the signature)
PAYMENT_VERIFIED → PAYMENT_COMPLETED           (on-chain settlement succeeded)
PAYMENT_VERIFIED → PAYMENT_FAILED              (settlement failed on-chain)
```

The agent drives the transitions: yield `request-input` for `PAYMENT_REQUIRED`, yield `done` with `buildX402PaymentCompletedMetadata(...)` for `PAYMENT_COMPLETED`, yield `error` with `buildX402PaymentFailedMetadata(...)` for `PAYMENT_FAILED`.

## Client

The client side is unchanged. `A2XClient` runs the Standalone Flow transparently when you pass an `x402` option — detect `payment-required`, sign one of the merchant's `accepts[]`, resubmit with the signed payload, return the final task.

```ts
import { A2XClient } from '@a2x/sdk/client';
import { privateKeyToAccount } from 'viem/accounts';

const client = new A2XClient('https://agent.example.com', {
  x402: {
    signer: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
    maxAmount: 10_000n,
    onPaymentRequired: (required) => {
      console.log('Merchant asks for', required.accepts);
    },
  },
});

const task = await client.sendMessage({
  message: {
    messageId: crypto.randomUUID(),
    role: 'user',
    parts: [{ text: 'hello' }],
  },
});
```

If the merchant's terminal task records a payment failure (the latest receipt is unsuccessful), the call throws `X402PaymentFailedError` with the on-chain reason. The full option surface is unchanged from prior releases:

| Field | Default | Purpose |
|---|---|---|
| `signer` | required | viem `LocalAccount` used to produce the EIP-3009 authorization. |
| `maxAmount` | no cap | Atomic-unit ceiling. Filters `accepts[]` before the selector runs. |
| `selectRequirement` | first `scheme === 'exact'` | Predicate over the (already filtered) requirements. Return `undefined` to abort. |
| `onPaymentRequired` | none | Hook between `payment-required` and signing. Return `false` to send `payment-rejected` cleanly; throw to abort *locally* without telling the merchant. |
| `maxRetries` | `0` | Additional sign+resubmit attempts when the merchant re-issues `payment-required` on the same task. |

### Extension activation header

Setting the `x402` option auto-registers `X402_EXTENSION_URI` so every JSON-RPC request carries the `X-A2A-Extensions` activation header (spec §8).

### Low-level: `signX402Payment`

Drive the dance manually when you need to inspect the `payment-required` task before signing — show a confirmation modal, fetch the signer's balance, or route across multiple wallets:

```ts
import { signX402Payment, getX402PaymentRequirements } from '@a2x/sdk/x402';

const first = await client.sendMessage({ message: { … } });
const required = getX402PaymentRequirements(first);
if (!required) return first;

const signed = await signX402Payment(first, { signer });

const final = await client.sendMessage({
  message: {
    messageId: crypto.randomUUID(),
    role: 'user',
    taskId: first.id,
    parts: [{ text: 'hello' }],
    metadata: signed.metadata,
  },
});
```

Declining manually:

```ts
import { rejectX402Payment } from '@a2x/sdk/x402';

const rejection = rejectX402Payment(first);
await client.sendMessage({
  message: {
    messageId: crypto.randomUUID(),
    role: 'user',
    taskId: first.id,
    parts: [{ text: '' }],
    metadata: rejection.metadata,
  },
});
```

### Reading receipts

```ts
import { getX402Receipts } from '@a2x/sdk/x402';

for (const receipt of getX402Receipts(task)) {
  console.log(receipt.success, receipt.transaction, receipt.network);
}
```

## Server-side enforcement

Per spec §8, x402-capable clients MUST include the extension URI in the `X-A2A-Extensions` HTTP header on every JSON-RPC request:

```
X-A2A-Extensions: https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2
```

When the merchant agent declares the extension with `required: true` on its AgentCard, `DefaultRequestHandler` rejects requests whose header doesn't list that URI (error `-32600`). The check only runs when a `RequestContext` is provided to `handler.handle()` — pure in-process invocations skip it.

## Supported scope

- **Standalone Flow** from a2a-x402 v0.2. Embedded Flow (AP2 `CartMandate` etc.) isn't yet wired up.
- **`exact` scheme, EVM networks** (`base`, `base-sepolia`, `polygon`, `avalanche`, …). Adding Solana support means passing a Solana-compatible signer in a later release.
- The base protocol is **x402 v1** (`x402Version: 1`). a2a-x402 v0.2 pins to this version.

## Reference

- Spec (in-repo): [`specification/a2a-x402-v0.2.md`](https://github.com/planetarium/a2x/blob/main/specification/a2a-x402-v0.2.md)
- Base protocol: [`specification/x402-v1.md`](https://github.com/planetarium/a2x/blob/main/specification/x402-v1.md)
- Migration: [Migrating off `x402PaymentHook`](./migration-x402-v2.md)
