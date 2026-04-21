# nextjs-x402 sample

An [A2A](https://a2a-protocol.org) agent built with Next.js and `@a2x/sdk` where every call is paywalled using the [a2a-x402 v0.2](https://github.com/google-agentic-commerce/a2a-x402) extension.

The agent itself is a trivial echo — the interesting bit is the x402 payment flow:

1. Client sends a message.
2. Server responds with task state `input-required` and `x402.payment.required` metadata (0.001 USDC on Base Sepolia).
3. Client signs an EIP-3009 authorization over that requirement with their wallet.
4. Client resubmits the same task with `x402.payment.submitted` + signed `PaymentPayload`.
5. Server verifies + settles through the Coinbase facilitator, runs the agent, and attaches the settlement receipt to the completed task.

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
a2x a2a send http://localhost:3000/api/a2a "hello"
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
    parts: [{ text: 'hello' }],
  },
});

console.log(task); // { state: "completed", artifacts: [...], receipts: [...] }
```

## What to tweak

- `src/lib/a2x-setup.ts` — swap `EchoAgent` for `LlmAgent` + your preferred provider to paywall a real assistant.
- `accepts[]` in the same file — adjust price, switch networks (e.g. `base` mainnet), or list multiple accept options.
- `facilitator` — point at your own facilitator via `X402_FACILITATOR_URL`.
