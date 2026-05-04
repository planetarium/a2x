# x402 Payments

Charge per call with on-chain cryptocurrency payments. A2X implements the [a2a-x402 v0.2](https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2.md) extension, which layers the [x402 payment protocol](https://x402.org) on top of A2A tasks.

The flow: the merchant agent responds to an unpaid request with `input-required` + `x402.payment.required`. The client signs a `PaymentPayload` with its wallet and resubmits the same task. The merchant verifies + settles the payment via an x402 **facilitator**, runs the agent, and attaches the settlement receipt to the completed task.

> Migrating from `X402PaymentExecutor` (SDK 0.x)? See [Migrating from X402PaymentExecutor](./migration-x402-v2.md). The wire format hasn't changed; only the server-side authoring surface has.

## Installation

```bash
pnpm add @a2x/sdk x402 viem
```

`x402` and `viem` are **optional peer dependencies** — only install them if you actually enable x402 on your agent or client. The SDK lazy-loads the `x402` runtime helpers on the first call to `signX402Payment` (or the first time `A2XClient.sendMessage` enters the dance), so non-x402 consumers can omit the dep without breaking bundlers.

## Server

The agent expresses payment gating inline by yielding a `request-input` event from `BaseAgent.run()`. The default `AgentExecutor` runs verify + settle through the `x402PaymentHook` you register in `inputRoundTripHooks`. There is no separate executor class to extend.

```ts
import {
  A2XAgent,
  AgentExecutor,
  BaseAgent,
  StreamingMode,
  InMemoryRunner,
  InMemoryTaskStore,
  x402PaymentHook,
  x402RequestPayment,
  readX402Settlement,
  X402_EXTENSION_URI,
} from '@a2x/sdk';

const ACCEPTS = [{
  network: 'base-sepolia',
  amount: '10000',                                      // 0.01 USDC (6 decimals)
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',  // USDC on Base Sepolia
  payTo: process.env.MERCHANT_ADDRESS!,
  // x402 v1 §PaymentRequirements requires both `resource` (a URL of the
  // protected resource) and `description` (human-readable). Wallet UIs
  // surface `description` to the user as the consent prompt.
  resource: 'https://api.example.com/premium',
  description: 'Premium agent access',
}];

class PaidAgent extends BaseAgent {
  constructor() {
    super({ name: 'paid_agent', description: 'Charges per call.' });
  }

  async *run(context) {
    if (!readX402Settlement(context).paid) {
      yield* x402RequestPayment({ accepts: ACCEPTS });
      return;
    }
    yield { type: 'text', role: 'agent', text: 'thanks for paying' };
    yield { type: 'done' };
  }
}

const runner = new InMemoryRunner({ agent: new PaidAgent(), appName: 'paid-agent' });
const executor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
  // Facilitator defaults to https://x402.org/facilitator.
  // Override if you run your own: x402PaymentHook({ facilitator: { url: 'https://…' } }).
  inputRoundTripHooks: [x402PaymentHook()],
});

const agent = new A2XAgent({ taskStore: new InMemoryTaskStore(), executor })
  .setName('Paid Agent')
  .setDescription('Charges per call')
  .addExtension({ uri: X402_EXTENSION_URI, required: true });
```

The two new pieces are:

- `x402RequestPayment({ accepts })` — generator helper the agent yields from to publish `payment-required` on the wire. The executor stops the generator and emits the `input-required` task automatically.
- `x402PaymentHook(options)` — `InputRoundTripHook` factory the executor consults on the resume turn. Encapsulates verify + settle so the agent stays focused on what to do once the payment lands.

`readX402Settlement(context)` is the read-side helper: it returns `{ paid, receipt }` based on whether the resume hook ran successfully. Use it to branch in the agent body — paid clients run the premium path, unpaid ones get the `payment-required` round-trip.

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

The "is this call paid?" decision lives in `agent.run()` now. The agent inspects whatever it needs (message content, headers, session state, an external policy service) and either yields `x402RequestPayment(...)` or proceeds for free.

```ts
class TieredAgent extends BaseAgent {
  async *run(context) {
    const text = lastUserText(context);
    const isPremium = text.length > 100 || PREMIUM_KEYWORDS.some((k) => text.includes(k));

    if (isPremium && !readX402Settlement(context).paid) {
      yield* x402RequestPayment({ accepts: PREMIUM_ACCEPTS });
      return;
    }

    yield { type: 'text', role: 'agent', text: isPremium ? 'Premium ...' : 'Free ...' };
    yield { type: 'done' };
  }
}
```

The single predicate now lives in one place — the agent body — instead of being duplicated between an executor option and the agent.

### Agent-driven payment requests (mid-execution)

The agent owns the payment decision, so it can request payment **after** classifying the user's intent (e.g. before invoking a paid tool):

```ts
class TranslationAgent extends BaseAgent {
  async *run(context) {
    const intent = classifyIntent(lastUserText(context));

    if (intent.kind === 'lookup') {
      yield* this._runLookup(intent.word);
      return;
    }

    if (intent.kind === 'translate') {
      if (!readX402Settlement(context).paid) {
        yield* x402RequestPayment({
          accepts: PREMIUM_ACCEPTS,
          description: `About to call deep_translate("${intent.text}")`,
        });
        return;
      }
      yield* this._runDeepTranslate(intent.text, intent.lang);
      return;
    }
  }
}
```

Same generator, same hook — no custom executor, no sentinel events, no session-state tricks. The `samples/nextjs-x402-agent-driven` sample exercises exactly this pattern.

### Custom facilitator

For self-hosted facilitators or tests, pass a `{ verify, settle }` pair instead of a URL:

```ts
x402PaymentHook({
  facilitator: {
    async verify(payload, requirements) { /* … */ return { isValid: true, payer: '0x…' }; },
    async settle(payload, requirements) { /* … */ return { success: true, transaction: '0x…', network: 'base-sepolia', payer: '0x…' }; },
  },
});
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

Every receipt — success or failure — carries a `payer` field per x402-v1 §5.3.2. Multi-wallet auditing and post-settlement bookkeeping branch on this; the SDK propagates the address the facilitator returned, falling back to the EVM authorization's `from` for shape-failure receipts where verify never ran.

Failures surface under `x402.payment.error` with one of the codes below. The seven names listed first come straight from spec §9.1; the remaining three are SDK-specific codes covering failure modes the SDK detects outside the facilitator's purview.

| Code | Source | Meaning |
|---|---|---|
| `INSUFFICIENT_FUNDS` | spec §9.1 | Wallet can't cover the payment. |
| `INVALID_SIGNATURE` | spec §9.1 | Authorization signature failed verification. |
| `EXPIRED_PAYMENT` | spec §9.1 | Authorization was submitted after its validity window. |
| `DUPLICATE_NONCE` | spec §9.1 | Nonce has already been spent. |
| `NETWORK_MISMATCH` | spec §9.1 | Payload's network doesn't match any advertised `accepts`. |
| `INVALID_AMOUNT` | spec §9.1 | Authorization value doesn't match the required amount. |
| `SETTLEMENT_FAILED` | spec §9.1 | On-chain settle call failed. |
| `invalid_x402_version` | x402-v1 §6 / §9 | Merchant published a non-1 `x402Version`; the SDK only speaks x402 v1. Surfaced client-side as `X402InvalidVersionError` before any authorization is signed. Wire value stays lowercase because a2a-x402 v0.2 §9.1 doesn't redefine it — x402-v1 §9 is the source of truth for this code. |
| `INVALID_PAYLOAD` | SDK | Payment payload is missing or structurally invalid. |
| `INVALID_PAY_TO` | SDK | Authorization target address doesn't match `payTo`. |
| `VERIFY_FAILED` | SDK | Facilitator rejected the signature, but the reason string didn't match any of the spec codes above. |

The SDK uses the facilitator's `invalidReason` string to dispatch into the spec codes (`mapVerifyFailureToCode()` exports the same logic if you need it client-side). Clients SHOULD branch on the spec codes first and treat `VERIFY_FAILED` as an unmapped fallback.

### Payment lifecycle

Every paid task runs through the same state machine (spec §7.1):

```
PAYMENT_REQUIRED → PAYMENT_REJECTED           (client declined the challenge)
PAYMENT_REQUIRED → PAYMENT_SUBMITTED          (client signed and resubmitted)
PAYMENT_SUBMITTED → PAYMENT_VERIFIED          (facilitator verified the signature)
PAYMENT_VERIFIED → PAYMENT_COMPLETED          (on-chain settlement succeeded)
PAYMENT_VERIFIED → PAYMENT_FAILED             (settlement failed on-chain)
```

The SDK emits `payment-verified` as a transient `working`-state event between submit and completion when streaming, so clients can surface a "settling on-chain…" indicator. In the blocking `execute()` path the state is recorded on `task.status` but clients only observe the final value.

### Retry-on-failure (opt-in)

By default, verify/settle failures terminate the task with state `failed` and an error code. Spec §9 also allows the merchant to "request a payment requirement with input-required again"; set `retryOnFailure: true` on the hook to pick that strategy — failures will re-publish `payment-required` on the same task with the prior failure reason carried in `X402PaymentRequiredResponse.error`, letting the client top up the wallet (or refresh the nonce) and resubmit without creating a new task.

```ts
x402PaymentHook({ retryOnFailure: true });
```

`x402.payment.receipts` accumulates every settle attempt (success or failure) across the task's lifetime per spec §7's "complete history" requirement.

### Rejection handling

When a client decides not to pay it can respond with `x402.payment.status: payment-rejected` (spec §5.4.2). The hook terminates the task with state `failed` and status `payment-rejected` — no further challenges are published, the loop ends.

On the client side, return `false` from `onPaymentRequired` to send `payment-rejected` cleanly; throwing aborts locally and leaves the merchant's task stranded in `input-required`. `rejectX402Payment(task)` is the lower-level primitive that produces the metadata block if you drive the dance manually.

## Client

### High-level: `A2XClient` with `x402`

`A2XClient` itself runs the x402 dance when you pass an `x402` option. Whether the agent gates on x402 is a property of its AgentCard, not the caller — so you don't have to pick between two client classes. If the agent never asks for payment, the client behaves as a plain A2A client.

```ts
import { A2XClient } from '@a2x/sdk/client';
import { privateKeyToAccount } from 'viem/accounts';

const client = new A2XClient('https://agent.example.com', {
  x402: {
    signer: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
    maxAmount: 10_000n,                          // optional; refuse anything above this
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

console.log(task.status.state); // "completed"
```

The same call site works for streaming. The dance happens in-band — the generator yields the merchant's `payment-required` event and then continues with the followup stream's `payment-verified → working → artifacts → payment-completed` events:

```ts
for await (const event of client.sendMessageStream({ message: { … } })) {
  console.log(event);
}
```

If the merchant's terminal task records a payment failure (verify or settle failed and the most recent receipt is unsuccessful), the call throws `X402PaymentFailedError` with the on-chain reason attached. The decision uses the *latest* receipt — resuming a task that has historical failure receipts but completed successfully (e.g. server-side retry) returns the task without throwing. If every requirement in `accepts[]` exceeds `maxAmount`, signing throws `X402NoSupportedRequirementError` before any authorization is created. If the merchant publishes an unsupported `x402Version`, signing throws `X402InvalidVersionError` (wire code `invalid_x402_version`, per x402-v1 §9).

The full option surface:

| Field | Default | Purpose |
|---|---|---|
| `signer` | required | viem `LocalAccount` used to produce the EIP-3009 authorization. |
| `maxAmount` | no cap | Atomic-unit ceiling. Filters `accepts[]` before the selector runs, so a custom `selectRequirement` only sees the affordable subset. |
| `selectRequirement` | first `scheme === 'exact'` | Predicate over the (already filtered) requirements. Return `undefined` to abort. |
| `onPaymentRequired` | none | Hook that fires after `payment-required` and before signing. Return `false` to send `payment-rejected` cleanly so the merchant's task terminates per spec §5.4.2; return `void`/`true` (or omit) to proceed; throw to abort *locally* without telling the merchant (the caller observes the unmodified `payment-required` task). |
| `maxRetries` | `0` | Maximum *additional* sign+resubmit attempts when the merchant runs `retryOnFailure: true` and re-issues `payment-required` on the same task. Set to `1` or more to opt into automatic retries; the dance bails on any non-`payment-required` terminal or when the budget is exhausted. |

### Extension activation header

Setting the `x402` option auto-registers `X402_EXTENSION_URI` so every JSON-RPC request carries the `X-A2A-Extensions` activation header (spec §8). You don't need to pass `extensions` separately for x402.

To activate other extensions, list them in `extensions` or call `client.registerExtension(uri)` at runtime:

```ts
new A2XClient(url, {
  extensions: ['https://example.org/some-extension'],
  x402: { signer },                              // X402_EXTENSION_URI auto-added
});
```

### Low-level: `signX402Payment`

When you need to inspect the `payment-required` task before signing — e.g. to show the user a confirmation modal, fetch the signer's balance, or route across multiple wallets — drive the dance manually using the primitives. `A2XClient` without the `x402` option will hand you the raw `payment-required` task, and `signX402Payment` produces the metadata block to attach to the followup `message/send` call.

```ts
import { A2XClient } from '@a2x/sdk/client';
import {
  signX402Payment,
  getX402PaymentRequirements,
} from '@a2x/sdk/x402';

const client = new A2XClient(url, {
  extensions: [X402_EXTENSION_URI], // still required for header activation
});

const first = await client.sendMessage({ message: { … } });
const required = getX402PaymentRequirements(first);
if (!required) {
  return first; // merchant didn't charge
}

// Show the cost to the user, wait for confirmation, etc.
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

Picking a specific requirement when the merchant offers several:

```ts
const signed = await signX402Payment(first, {
  signer,
  selectRequirement: (accepts) =>
    accepts.find((r) => r.network === 'base-sepolia'),
});
```

Declining a payment manually — produces the metadata block to attach to a follow-up `message/send` call so the merchant terminates the task per spec §5.4.2 instead of leaving it stranded in `input-required`:

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

const receipts = getX402Receipts(task);
for (const receipt of receipts) {
  console.log(receipt.success, receipt.transaction, receipt.network);
}
```

## Server-side enforcement

Per spec §8, x402-capable clients MUST include the extension URI in the `X-A2A-Extensions` HTTP header on every JSON-RPC request:

```
X-A2A-Extensions: https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2
```

When the merchant agent declares the extension with `required: true` on its AgentCard, `DefaultRequestHandler` rejects requests whose header doesn't list that URI (error `-32600`). The check only runs when a `RequestContext` is provided to `handler.handle()` — pure in-process invocations skip it.

The client side is covered for you when you set `A2XClientOptions.x402` — see the section above. If you drive the dance manually via `signX402Payment`, pass `extensions: [X402_EXTENSION_URI]` to the `A2XClient` constructor (or call `client.registerExtension(X402_EXTENSION_URI)`) so the header gets emitted on every request.

## Supported scope

- **Standalone Flow** from a2a-x402 v0.2. Embedded Flow (AP2 `CartMandate` etc.) isn't yet wired up — the extension spec notes the embedded flow "supports" nesting but implementing it is separate work.
- **`exact` scheme, EVM networks** (`base`, `base-sepolia`, `polygon`, `avalanche`, …). The x402 npm package powers signing; adding Solana/SVM support means passing a Solana-compatible signer in a later release.
- The base protocol is **x402 v1** (`x402Version: 1`). a2a-x402 v0.2 pins to this version; x402 v2 exists as a forward-looking draft but a2a-x402 has not adopted it yet.

## Reference

- Spec (in-repo): [`specification/a2a-x402-v0.2.md`](https://github.com/planetarium/a2x/blob/main/specification/a2a-x402-v0.2.md)
- Base protocol: [`specification/x402-v1.md`](https://github.com/planetarium/a2x/blob/main/specification/x402-v1.md)
- A2A transport binding: [`specification/x402-transport-a2a-v1.md`](https://github.com/planetarium/a2x/blob/main/specification/x402-transport-a2a-v1.md)
- Migration: [Migrating from X402PaymentExecutor](./migration-x402-v2.md)
