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

By default, verify/settle failures terminate the task with state `failed` and an error code. Spec §9 also allows the merchant to "request a payment requirement with input-required again"; set `retryOnFailure: true` on the executor to pick that strategy — failures will re-publish `payment-required` on the same task with the prior failure reason carried in `X402PaymentRequiredResponse.error`, letting the client top up the wallet (or refresh the nonce) and resubmit without creating a new task.

```ts
new X402PaymentExecutor(inner, {
  accepts: [...],
  retryOnFailure: true,
});
```

`x402.payment.receipts` accumulates every settle attempt (success or failure) across the task's lifetime per spec §7's "complete history" requirement.

### Rejection handling

When a client decides not to pay it can respond with `x402.payment.status: payment-rejected` (spec §5.4.2). The executor terminates the task with state `failed` and status `payment-rejected` — no further challenges are published, the loop ends.

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

## Extension activation

Per spec §8, x402-capable clients MUST include the extension URI in the `X-A2A-Extensions` HTTP header on every JSON-RPC request. `X402Client` does this automatically — wrapping an `A2XClient` registers `X402_EXTENSION_URI` on it so subsequent `sendMessage` / `sendMessageStream` calls emit the header:

```
X-A2A-Extensions: https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2
```

If you're driving `A2XClient` directly (without `X402Client`), pass `extensions` to the constructor:

```ts
new A2XClient(url, {
  extensions: [X402_EXTENSION_URI],
  // …other options
});
```

Or register at runtime (the same mechanism `X402Client` uses internally):

```ts
client.registerExtension(X402_EXTENSION_URI);
```

**Server side.** When an agent declares an extension with `required: true`, `DefaultRequestHandler` rejects requests whose `X-A2A-Extensions` header doesn't list that URI (error `-32600`). The check is only applied when a `RequestContext` is provided to `handler.handle()` — pure in-process invocations skip it.

## Supported scope

- **Standalone Flow** from a2a-x402 v0.2. Embedded Flow (AP2 `CartMandate` etc.) isn't yet wired up — the extension spec notes the embedded flow "supports" nesting but implementing it is separate work.
- **`exact` scheme, EVM networks** (`base`, `base-sepolia`, `polygon`, `avalanche`, …). The x402 npm package powers signing; adding Solana/SVM support means passing a Solana-compatible signer in a later release.
- The base protocol is **x402 v1** (`x402Version: 1`). a2a-x402 v0.2 pins to this version; x402 v2 exists as a forward-looking draft but a2a-x402 has not adopted it yet.

## Reference

- Spec (in-repo): [`specification/a2a-x402-v0.2.md`](https://github.com/planetarium/a2x/blob/main/specification/a2a-x402-v0.2.md)
- Base protocol: [`specification/x402-v1.md`](https://github.com/planetarium/a2x/blob/main/specification/x402-v1.md)
- A2A transport binding: [`specification/x402-transport-a2a-v1.md`](https://github.com/planetarium/a2x/blob/main/specification/x402-transport-a2a-v1.md)
