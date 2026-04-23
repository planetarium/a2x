# nextjs-x402 sample

An [A2A](https://a2a-protocol.org) agent built with Next.js and `@a2x/sdk` that demos **both** payment flows defined by [a2a-x402 v0.2](https://github.com/google-agentic-commerce/a2a-x402):

- **Standalone gate.** A fixed browsing fee (0.001 USDC on Base Sepolia) is charged before the agent even starts.
- **Embedded checkout.** Once inside, the agent offers a tiny inventory and asks for a per-item payment mid-execution via an artifact-shaped challenge. Ship happens after the embedded charge settles.

The two charges stack: a single `sendMessage` call settles the gate, lets the agent think, settles the embedded checkout, and returns the completed task with both receipts.

### Payment lifecycle

1. Client sends a message.
2. Server responds with `input-required` + `x402.payment.required` (gate challenge, 0.001 USDC).
3. Client signs an EIP-3009 authorization and resubmits → gate settles → agent runs.
4. Agent yields `paymentRequired` → server emits an artifact-shaped cart challenge (0.05–0.12 USDC).
5. Client signs the embedded payload and resubmits → embedded payment settles → agent resumes and ships the item.
6. Completed task carries two receipts stacked under `x402.payment.receipts`.

## Setup

```bash
cp .env.example .env
# Fill in X402_MERCHANT_ADDRESS with the wallet you want to receive payments on

pnpm install
pnpm dev
```

The server listens on `http://localhost:3000` with:

- `GET /.well-known/agent.json` — AgentCard
- `POST /api/a2a` — JSON-RPC (`message/send`, `message/stream`, etc.)

## Calling it

Using `@a2x/cli` (with wallet subsystem):

```bash
# Create and select a wallet
a2x wallet create
a2x wallet use default

# Fund with Base Sepolia USDC via the Circle faucet:
#   https://faucet.circle.com
# Select "Base Sepolia" and use the address from `a2x wallet show`

# Call the paywalled agent — the CLI handles the full x402 dance
a2x a2a send http://localhost:3000/api/a2a "sku-air-max"
# Two payments will settle: the 0.001 USDC gate, then 0.12 USDC for the Air Max.
# Try "sku-react-tee" for the cheaper inventory item.
```

Using the SDK directly:

```ts
import { A2XClient } from '@a2x/sdk/client';
import { X402Client } from '@a2x/sdk/x402';
import { privateKeyToAccount } from 'viem/accounts';

const x402 = new X402Client(new A2XClient('http://localhost:3000/api/a2a'), {
  signer: privateKeyToAccount(process.env.PRIVATE_KEY as `0x${string}`),
});

const task = await x402.sendMessage({
  message: {
    messageId: crypto.randomUUID(),
    role: 'user',
    parts: [{ text: 'sku-air-max' }],
  },
});

console.log(task); // { state: "completed", artifacts: [...cart + shipping...], receipts: [gate, embedded] }
```

## What to tweak

- `src/lib/a2x-setup.ts` — swap `StorefrontAgent` for `LlmAgent` + your preferred provider to paywall a real assistant. Drop the gate `accepts` entirely for a purchase-only (no gate) flow.
- `INVENTORY` in the same file — add SKUs, rename, reprice. The embedded challenge is built from the selected entry.
- `accepts[]` in the same file — adjust the gate price, switch networks (e.g. `base` mainnet), or list multiple accept options.
- `facilitator` — point at your own facilitator via `X402_FACILITATOR_URL`.
