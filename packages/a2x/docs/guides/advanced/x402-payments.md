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

The agent owns the full payment flow. Each helper is one step you can compose, intercept, and customize freely.

```ts
import {
  A2XAgent,
  AgentExecutor,
  BaseAgent,
  StreamingMode,
  InMemoryRunner,
  InMemoryTaskStore,
  X402_EXTENSION_URI,
  X402_ERROR_CODES,
  X402_PAYMENT_STATUS,
  buildX402PaymentCompletedMetadata,
  buildX402PaymentFailedMetadata,
  mapVerifyFailureToCode,
  normalizeX402Accept,
  parseX402PaymentSubmission,
  pickX402Requirement,
  resolveFacilitator,
  validateX402PayloadShape,
  x402RequestPayment,
} from '@a2x/sdk';

const ACCEPTS = [{
  network: 'base-sepolia',
  amount: '10000',                                       // 0.01 USDC (6 decimals)
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',   // USDC on Base Sepolia
  payTo: process.env.MERCHANT_ADDRESS!,
  resource: 'https://api.example.com/premium',
  description: 'Premium agent access',
}];

class PaidAgent extends BaseAgent {
  constructor(private readonly facilitator = resolveFacilitator()) {
    super({ name: 'paid_agent', description: 'Charges per call.' });
  }

  async *run(context) {
    const submission = parseX402PaymentSubmission(context.message!);

    // Turn 1 — no submission yet, advertise the bill.
    if (!submission) {
      yield* x402RequestPayment({ accepts: ACCEPTS });
      return;
    }

    // Client declined.
    if (submission.status !== X402_PAYMENT_STATUS.SUBMITTED || !submission.payload) {
      yield {
        type: 'error',
        error: new Error('Payment was not submitted.'),
        metadata: buildX402PaymentFailedMetadata({
          code: X402_ERROR_CODES.INVALID_PAYLOAD,
          reason: 'Payment was not submitted.',
        }),
      };
      return;
    }

    // Match the submitted payment against what we offered. A real merchant
    // looks the offering up by context.taskId from its own store; here we
    // re-derive it because the offering is constant.
    const requirements = ACCEPTS.map(normalizeX402Accept);
    const requirement = pickX402Requirement(submission.payload, requirements);
    if (!requirement) {
      yield {
        type: 'error',
        error: new Error('No matching requirement.'),
        metadata: buildX402PaymentFailedMetadata({
          code: X402_ERROR_CODES.NETWORK_MISMATCH,
          reason: 'Submitted network/scheme is not one of the offered options.',
        }),
      };
      return;
    }

    // Local shape validation. Returns an array of issues — the agent
    // decides which to treat as fatal.
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

    // verify → custom logic → settle → custom logic. Each step is exposed
    // independently so you can record audit logs, run fraud checks, or
    // pre-allocate downstream resources between them.
    const verify = await this.facilitator.verify(submission.payload, requirement);
    if (!verify.isValid) {
      yield {
        type: 'error',
        error: new Error(verify.invalidReason ?? 'verify failed'),
        metadata: buildX402PaymentFailedMetadata({
          code: mapVerifyFailureToCode(verify.invalidReason),
          reason: verify.invalidReason ?? 'Payment verification failed.',
        }),
      };
      return;
    }

    const settle = await this.facilitator.settle(submission.payload, requirement);
    if (!settle.success) {
      yield {
        type: 'error',
        error: new Error(settle.errorReason ?? 'settle failed'),
        metadata: buildX402PaymentFailedMetadata({
          code: X402_ERROR_CODES.SETTLEMENT_FAILED,
          reason: settle.errorReason ?? 'Payment settlement failed.',
        }),
      };
      return;
    }

    yield { type: 'text', role: 'agent', text: 'thanks for paying' };
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

const runner = new InMemoryRunner({ agent: new PaidAgent(), appName: 'paid-agent' });
const executor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
});

const agent = new A2XAgent({ taskStore: new InMemoryTaskStore(), executor })
  .setName('Paid Agent')
  .setDescription('Charges per call')
  .addExtension({ uri: X402_EXTENSION_URI, required: true });
```

### Helper inventory

| Helper | One step it does |
|---|---|
| `x402RequestPayment({ accepts, description?, previousError? })` | Generator that yields the `request-input` event with `payment-required` metadata. |
| `buildX402PaymentRequiredMetadata(input)` | Same metadata, returned as a plain object (use when you want to compose your own event). |
| `parseX402PaymentSubmission(message)` | Read the x402 status / payload / authorization fields off an incoming message. |
| `pickX402Requirement(payload, requirements)` | Find the requirement matching the submitted payload's network + scheme. |
| `validateX402PayloadShape(payload, requirement)` | Local checks: payTo match, amount cap, EVM-only support. Returns an array of issues; empty = OK. |
| `normalizeX402Accept(accept)` | Convert your offering shape to the spec's `X402PaymentRequirements` (applies default scheme, mimeType, timeout, extra). |
| `mapVerifyFailureToCode(reason)` | Translate a facilitator's free-form `invalidReason` to a spec §9.1 error code. |
| `resolveFacilitator(config?)` | Build the `{ verify, settle }` adapter from a URL or pass-through custom object. |
| `buildX402PaymentCompletedMetadata({ receipt, priorReceipts? })` | Final-message metadata for a successful payment. Pair with `{ type: 'done', metadata: ... }`. |
| `buildX402PaymentFailedMetadata({ code, reason, failureReceipt?, priorReceipts? })` | Final-message metadata for a failed payment. Pair with `{ type: 'error', error, metadata: ... }`. |
| `buildX402PaymentVerifiedMetadata()` | Intermediate `payment-verified` metadata for streaming (spec §7.1). |

The agent calls `facilitator.verify()` and `facilitator.settle()` directly — the SDK never bundles them. Insert any logic you need between the two.

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
