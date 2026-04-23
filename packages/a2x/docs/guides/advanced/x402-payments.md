# x402 Payments

Charge per call with on-chain cryptocurrency payments. A2X implements the [a2a-x402 v0.2](https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2.md) extension, which layers the [x402 payment protocol](https://x402.org) on top of A2A tasks.

The flow: the merchant agent responds to an unpaid request with `input-required` + `x402.payment.required`. The client signs a `PaymentPayload` with its wallet and resubmits the same task. The merchant verifies + settles the payment via an x402 **facilitator**, runs the agent, and attaches the settlement receipt to the completed task.

## Installation

```bash
pnpm add @a2x/sdk x402 viem
```

`x402` and `viem` are **optional peer dependencies** — only install them if you actually enable x402 on your agent or client.

## Server

```ts
import { A2XAgent, AgentExecutor, StreamingMode, InMemoryTaskStore } from '@a2x/sdk';
import { X402PaymentExecutor, X402_EXTENSION_URI } from '@a2x/sdk/x402';

const inner = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
});

const executor = new X402PaymentExecutor(inner, {
  accepts: [{
    network: 'base-sepolia',
    amount: '10000',                                   // 0.01 USDC (6 decimals)
    asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // USDC on Base Sepolia
    payTo: process.env.MERCHANT_ADDRESS!,
    description: 'Premium agent access',
  }],
  // Facilitator defaults to https://x402.org/facilitator.
  // Override if you run your own: facilitator: { url: 'https://…' }
});

const agent = new A2XAgent({ taskStore: new InMemoryTaskStore(), executor })
  .setName('Paid Agent')
  .setDescription('Charges per call')
  .addExtension({ uri: X402_EXTENSION_URI, required: true });
```

### Multiple payment options

Put more than one entry in `accepts[]` and the client picks one. Use this for multi-network support:

```ts
accepts: [
  { network: 'base-sepolia', amount: '10000', asset: USDC_BASE_SEPOLIA, payTo, description: 'Testnet' },
  { network: 'base',         amount: '10000', asset: USDC_BASE,         payTo, description: 'Mainnet' },
],
```

### Conditional pricing

`requiresPayment` is a predicate over the incoming message. Return `false` to pass the message straight through to the inner executor without charging:

```ts
new X402PaymentExecutor(inner, {
  accepts: [...],
  requiresPayment: (message) => {
    // Free tier: short health-check messages
    const text = message.parts.find((p) => 'text' in p)?.text ?? '';
    return text.length > 10;
  },
});
```

### Custom facilitator

For self-hosted facilitators or tests, pass a `{ verify, settle }` pair instead of a URL:

```ts
new X402PaymentExecutor(inner, {
  accepts: [...],
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
    { "success": true, "transaction": "0x…", "network": "base-sepolia" }
  ]
}
```

Failures surface under `x402.payment.error` with one of `INVALID_PAYLOAD`, `NETWORK_MISMATCH`, `INVALID_PAY_TO`, `AMOUNT_EXCEEDED`, `VERIFY_FAILED`, `SETTLE_FAILED`.

## Client

### High-level: `X402Client`

```ts
import { A2XClient } from '@a2x/sdk/client';
import { X402Client } from '@a2x/sdk/x402';
import { privateKeyToAccount } from 'viem/accounts';

const x402 = new X402Client(new A2XClient('https://agent.example.com'), {
  signer: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
  onPaymentRequired: (required) => {
    console.log('Merchant asks for', required.accepts);
  },
});

const task = await x402.sendMessage({
  message: {
    messageId: crypto.randomUUID(),
    role: 'user',
    parts: [{ text: 'hello' }],
  },
});

console.log(task.status.state); // "completed"
```

If the merchant rejects the payment (verify or settle failed), `sendMessage` throws `X402PaymentFailedError` with the on-chain reason attached.

### Low-level: `signX402Payment`

Use this when you need to inspect the `payment-required` task before signing — e.g. to show the user a confirmation modal, to fetch the signer's balance, or to route across multiple wallets.

```ts
import {
  signX402Payment,
  getX402PaymentRequirements,
} from '@a2x/sdk/x402';

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

### Reading receipts

```ts
import { getX402Receipts } from '@a2x/sdk/x402';

const receipts = getX402Receipts(task);
for (const receipt of receipts) {
  console.log(receipt.success, receipt.transaction, receipt.network);
}
```

## Embedded Flow

The Standalone flow above gates the whole task behind a single charge at the door. The **Embedded Flow** from a2a-x402 v0.2 lets an agent ask for an additional payment *mid-execution* — useful for cart-style checkouts, premium-asset delivery, or any "charge once you've decided to buy" flow. The gate and embedded charges compose: a call can settle both, or skip the gate entirely and charge only on purchase.

### How it works

1. The inner agent yields `paymentRequired` (optionally carrying a higher-level wrapper like an AP2 `CartMandate`).
2. The executor stashes the paused generator, emits an artifact carrying the challenge, and transitions the task into `input-required`.
3. The client signs the payload and resubmits.
4. The executor verifies + settles, then resumes the generator from where it paused — no re-run.

Per spec §4.2 the status metadata carries only `x402.payment.status: payment-required` (no `x402.payment.required` key); the actual challenge lives on `task.artifacts[]`.

### Server — agent yielding mid-execution payment

```ts
import { BaseAgent, type AgentEvent } from '@a2x/sdk';
import { paymentRequiredEvent, X402PaymentExecutor } from '@a2x/sdk/x402';

class CartAgent extends BaseAgent {
  async *run(): AsyncGenerator<AgentEvent> {
    yield { type: 'text', text: 'Your cart: 1× Nike Air Max — 120 USDC.' };

    // Pause here until the client pays.
    yield paymentRequiredEvent({
      accepts: [{
        network: 'base',
        amount: '120000000',               // 120 USDC (6 decimals)
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913',
        payTo: process.env.MERCHANT_ADDRESS!,
        description: 'Nike Air Max checkout',
      }],
      // Optional: attach your own higher-level object (rendered on the
      // emitted artifact next to the x402 challenge).
      embeddedObject: { cartId: 'cart-shoes-123', total: { currency: 'USD', value: 120 } },
      artifactName: 'demo-cart',
    });

    yield { type: 'text', text: 'Paid — shipping shoes now.' };
    yield { type: 'done' };
  }
}
```

Pair it with a gate-less executor if you only want per-purchase pricing:

```ts
const executor = new X402PaymentExecutor(inner, {
  // No `accepts` → no gate. The executor only charges when the agent emits
  // `paymentRequired`.
});
```

### Dynamic pricing with `resolveAccepts`

If the price depends on the cart (or on who's asking, or on the current inventory), let the agent yield `paymentRequired` without inline `accepts` and resolve them at the executor layer:

```ts
const executor = new X402PaymentExecutor(inner, {
  resolveAccepts: async ({ embeddedObject, task, message }) => {
    const cart = embeddedObject as { productId: string };
    const unitPrice = await priceBook.lookup(cart.productId); // e.g. 75000000
    return [{
      network: 'base',
      amount: unitPrice,
      asset: USDC_BASE,
      payTo,
      description: `Checkout for ${cart.productId}`,
    }];
  },
});

class LookupAgent extends BaseAgent {
  async *run() {
    yield paymentRequiredEvent({ embeddedObject: { productId: 'sku-42' } });
    yield { type: 'text', text: 'Delivered.' };
    yield { type: 'done' };
  }
}
```

Inline `accepts` always wins — `resolveAccepts` is only consulted when the event omits them.

### Client — stacking gate + embedded in one call

`X402Client.sendMessage` loops over every payment challenge the merchant emits:

```ts
const x402 = new X402Client(new A2XClient(url), {
  signer,
  onPaymentRequired: (required) => {
    console.log('Gate asks for', required.accepts);
  },
  onEmbeddedPaymentRequired: (challenge) => {
    console.log('Embedded charge:', challenge.required.accepts, 'artifact=', challenge.artifactId);
  },
  // Safety cap — default 8. Raise for flows with many sequential charges.
  maxPaymentHops: 8,
});

const task = await x402.sendMessage({
  message: {
    messageId: crypto.randomUUID(),
    role: 'user',
    parts: [{ text: 'buy shoes' }],
  },
});
console.log(task.status.state); // "completed" after the gate AND the embedded charge settle
```

### Parsing Embedded challenges yourself

For custom UIs (render the cart, show a confirmation modal, swap signers per artifact), use the primitive:

```ts
import { getEmbeddedX402Challenges, signX402Payment } from '@a2x/sdk/x402';

const task = await client.sendMessage({ message: { … } });
const challenges = getEmbeddedX402Challenges(task);
for (const ch of challenges) {
  console.log('artifactId', ch.artifactId);
  console.log('full data (AP2, cart, etc.)', ch.data);
  console.log('x402 requirements', ch.required.accepts);
}

const signed = await signX402Payment(task, { signer });
const next = await client.sendMessage({
  message: {
    messageId: crypto.randomUUID(),
    role: 'user',
    taskId: task.id,
    parts: [{ text: '' }],
    metadata: signed.metadata,
  },
});
```

`getEmbeddedX402Challenges` recognizes the bare shape the SDK emits (data-part with an `x402.payment.required` key) AND `x402PaymentRequiredResponse`-shaped objects nested anywhere inside a higher-level wrapper (AP2 `CartMandate`, your own custom schema, etc.). If you transport the x402 payload inside your wrapper's `message.parts` on submission (true AP2), unwrap it into `message.metadata['x402.payment.payload']` yourself before handing to the SDK.

### What gets emitted

On an embedded charge, the task transitions to `input-required` and the status message carries just:

```json
{
  "x402.payment.status": "payment-required"
}
```

The actual challenge sits on a `task.artifacts[]` entry (named `x402-payment-required` by default, or whatever you passed as `artifactName`):

```json
{
  "artifactId": "x402-challenge-1712345678",
  "name": "demo-cart",
  "parts": [{
    "data": {
      "cartId": "cart-shoes-123",
      "total": { "currency": "USD", "value": 120 },
      "x402.payment.required": {
        "x402Version": 1,
        "accepts": [{ /* PaymentRequirements */ }]
      }
    }
  }]
}
```

On success, all receipts (gate + every embedded charge) stack under `x402.payment.receipts`:

```json
{
  "x402.payment.status": "payment-completed",
  "x402.payment.receipts": [
    { "success": true, "transaction": "0x…", "network": "base-sepolia" },
    { "success": true, "transaction": "0x…", "network": "base-sepolia" }
  ]
}
```

## Supported scope

- **Standalone Flow + Embedded Flow** from a2a-x402 v0.2. The SDK handles bare embedded challenges out of the box; for full AP2 `CartMandate`/`PaymentMandate` interop you can ship your own wrapper via `embeddedObject` and unwrap the payload on submission yourself (the data part shape is preserved verbatim).
- **`exact` scheme, EVM networks** (`base`, `base-sepolia`, `polygon`, `avalanche`, …). The x402 npm package powers signing; adding Solana/SVM support means passing a Solana-compatible signer in a later release.
- The base protocol is **x402 v1** (`x402Version: 1`). a2a-x402 v0.2 pins to this version; x402 v2 exists as a forward-looking draft but a2a-x402 has not adopted it yet.
- Embedded-flow pause/resume is **in-memory** on the server: the paused generator lives in the `X402PaymentExecutor` instance keyed by `taskId`. If the server restarts between `paymentRequired` and the client's follow-up, the pending charge is lost (the task is effectively orphaned). Horizontally-scaled deployments should pin task resumption back to the originating instance.

## Reference

- Spec (in-repo): [`specification/a2a-x402-v0.2.md`](https://github.com/planetarium/a2x/blob/main/specification/a2a-x402-v0.2.md)
- Base protocol: [`specification/x402-v1.md`](https://github.com/planetarium/a2x/blob/main/specification/x402-v1.md)
- A2A transport binding: [`specification/x402-transport-a2a-v1.md`](https://github.com/planetarium/a2x/blob/main/specification/x402-transport-a2a-v1.md)
