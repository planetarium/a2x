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
  .setCapabilities({
    extensions: [{ uri: X402_EXTENSION_URI, required: true }],
  });
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

## Supported scope

- **Standalone Flow** from a2a-x402 v0.2. Embedded Flow (AP2 `CartMandate` etc.) isn't yet wired up — the extension spec notes the embedded flow "supports" nesting but implementing it is separate work.
- **`exact` scheme, EVM networks** (`base`, `base-sepolia`, `polygon`, `avalanche`, …). The x402 npm package powers signing; adding Solana/SVM support means passing a Solana-compatible signer in a later release.
- The base protocol is **x402 v1** (`x402Version: 1`). a2a-x402 v0.2 pins to this version; x402 v2 exists as a forward-looking draft but a2a-x402 has not adopted it yet.

## Reference

- Spec (in-repo): [`specification/a2a-x402-v0.2.md`](https://github.com/planetarium/a2x/blob/main/specification/a2a-x402-v0.2.md)
- Base protocol: [`specification/x402-v1.md`](https://github.com/planetarium/a2x/blob/main/specification/x402-v1.md)
- A2A transport binding: [`specification/x402-transport-a2a-v1.md`](https://github.com/planetarium/a2x/blob/main/specification/x402-transport-a2a-v1.md)
