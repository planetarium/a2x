# x402 Payments

Charge per call with on-chain cryptocurrency payments. A2X implements the x402 A2A transport on top of A2A tasks, speaking **both versions** of the x402 protocol on the wire: the legacy V1 envelopes ([a2a-x402 v0.2](https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2/spec.md)) and the V2 envelopes defined by the [x402 Foundation A2A transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/a2a.md).

The flow: the merchant agent responds to an unpaid request with `input-required` + `x402.payment.required`. The client signs a `PaymentPayload` with its wallet and resubmits the same task. The merchant validates the payload, verifies it via an x402 **facilitator**, settles on-chain, and attaches the settlement receipt to the completed task. This flow is identical across versions — only the JSON envelope shapes differ (see [Protocol versions](#protocol-versions-v1--v2)).

> **What changed in this release.** The SDK no longer ships a payment *flow* — only stateless helpers. The agent owns when to request payment, what was offered, how to validate the submission, whether to retry, and what to do between `verify` and `settle`. The previous `x402PaymentHook` / `inputRoundTripHooks` API is removed; see [Migrating from X402PaymentExecutor / x402PaymentHook](./migration-x402-v2.md) for the migration steps.

## Installation

```bash
pnpm add @a2x/sdk @x402/core @x402/evm viem
```

`@x402/core`, `@x402/evm`, and `viem` are **optional peer dependencies** — only install them if you actually enable x402 on your agent or client. The SDK lazy-loads the signing runtime on the first call to `signX402Payment` (or the first time `A2XClient.sendMessage` enters the dance) and the facilitator client on the first `verify`/`settle`, so non-x402 consumers can omit the deps without breaking bundlers. One `@x402/evm` scheme registration signs both V1 and V2 payments.

Because the load is lazy, a missing peer isn't caught at install, typecheck, or startup — it surfaces on the first real payment. The SDK translates that into `X402PeerMissingError`, which names the packages to install:

```
X402PeerMissingError: Cannot load "@x402/core", required for x402 payments.
Install the optional peer dependencies:
  npm install @x402/core @x402/evm viem
Upgrading from @a2x/sdk 0.15 or earlier? The signing and facilitator runtime
moved from `x402` to `@x402/core` + `@x402/evm`.
```

The failed load isn't cached, so a long-running server recovers on the next attempt once the peers are installed — no restart needed.

## Protocol versions (V1 / V2)

The two wire versions differ only in envelope shape:

- **V1** (`x402Version: 1`) — bare network names (`base-sepolia`), `maxAmountRequired`, `resource`/`description`/`mimeType` inline.
- **V2** (`x402Version: 2`) — CAIP-2 networks (`eip155:84532`), `amount`, a hoisted top-level `resource` object, and a `PaymentPayload` that echoes the chosen requirement under `accepted`.

The five `x402.payment.*` metadata keys, the payment status lifecycle, and the EIP-3009 signing typed-data are identical across versions.

> **Version is signalled by `x402Version` in the envelope, not by the extension URI.** The URI the foundation transport mandates (`X402_FOUNDATION_EXTENSION_URI`, `github.com/google-a2a/a2a-x402/v0.1`) is **version-neutral** — the foundation's V1 and V2 transport docs declare the *same* URI, and the `v0.1` there is the *extension spec's* version, not the x402 protocol version. There is no URI that means "send me V2", so a version cannot be requested over the activation channel at all.
>
> The two URIs a2x knows are the two spec versions of one upstream extension (`google-agentic-commerce/a2a-x402`; the `google-a2a` path redirects there). v0.1 declares the URI above; v0.2 declares `X402_EXTENSION_URI`. A2A mandates a new URI per breaking version, so they are distinct identifiers rather than aliases — but the foundation transport standardized on v0.1, so **a2x advertises the older extension spec while emitting the newer wire version**. That reads backwards and is intentional. Neither URI is registered in A2A's official `a2a-protocol.org/extensions/` namespace.

**A server speaks exactly one version.** Because no activation URI can express a version, a2x does not negotiate one per request — the server emits its configured `x402Version` (**V1** by default — the version the upstream `x402_a2a` reference lineage decodes) and the **client signs whatever version it receives**. This matches how every other known implementation behaves: deployed x402-over-A2A peers are all single-version (the reference-library lineage is V1-only, [Bindu](https://github.com/GetBindu/Bindu) is V2-only), so the version is a property of the deployment, not of the round-trip.

So **out of the box a2x↔a2x runs V1.** To run V2, the server opts in: `new X402Context({ x402Version: 2 })` **and** advertise `X402_FOUNDATION_EXTENSION_URI` on its AgentCard.

The one version signal the activation channel does carry is the legacy v0.2 URI: its defining spec pairs it exclusively with V1 wire structures, so activating it declares a **V1-only client**. A V1 server serves it normally. A V2 server **refuses it fast** — `requestPayment` yields a `payment-failed` event with `invalid_x402_version` (in version-neutral metadata the client can decode) instead of emitting V2 envelopes the client said it cannot parse. Per A2A's extension rules an agent must not silently fall back to a different version, and a2x doesn't: a deployment that needs to serve both populations runs a V1 endpoint and a V2 endpoint.

To declare V1-only from an a2x client (e.g. tooling built against V1 envelopes), register the URI yourself:

```ts
new A2XClient(url, {
  x402: { signer },
  extensions: [X402_EXTENSION_URI],   // explicit V1-only declaration — survives the card-based upgrade
});
```

To keep legacy clients working on a V1 agent, declare both URIs on your AgentCard (see [Protocol Extensions](./extensions.md)) — a2x treats them as an activation family so a v0.2-only client still satisfies the requirement.

## Server

The agent owns the full payment flow. The recommended way to write x402 agents is to instantiate an `X402Context` once, pass it into the agent, and dispatch on `classify(ctx)` inside `run()`. The context bundles three pieces every x402 agent needs together:

- an **offering store** that remembers what was advertised for each `taskId` (so the resume turn validates against the right requirement),
- a **facilitator** that runs on-chain verify + settle,
- **event builders** that produce the right wire metadata for each terminal state.

No method bundles `verify` + `settle` — they stay separate so the agent can do anything between them (audit logs, fraud checks, reward pre-allocation, …).

```ts
import {
  A2XServer,
  AgentExecutor,
  BaseAgent,
  StreamingMode,
  InMemoryRunner,
  InMemoryTaskStore,
} from '@a2x/sdk';
import {
  X402Context,
  X402_FOUNDATION_EXTENSION_URI,
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

const agent = new A2XServer({ taskStore: new InMemoryTaskStore(), executor })
  .setName('Paid Agent')
  .setDescription('Charges per call')
  .addExtension({ uri: X402_FOUNDATION_EXTENSION_URI, required: true });
```

Declare the foundation URI, not the legacy `X402_EXTENSION_URI`. The two are an
activation family, so a legacy v0.2 client still passes the `required` check on
a V1 agent — while an `x402Version: 2` agent refuses its activation at
`requestPayment` with a clear `invalid_x402_version` failure.

### `X402Context` API

| Member | What it does |
|---|---|
| `new X402Context({ store?, facilitator?, x402Version? })` | Construct once. `store` defaults to `new InMemoryX402Store()`. `facilitator` accepts a `FacilitatorUrlConfig`, a custom `X402Facilitator` impl, or `undefined` (defaults to `https://x402.org/facilitator`). `x402Version` is the single wire version this server speaks (default `1`). |
| `x402.requestPayment(ctx, { accepts, description?, previousError?, extensions?, expiresInSeconds? })` | Async generator. Persists the offering keyed by `ctx.taskId` (with optional TTL) and yields the `request-input` event. `extensions` advertises facilitator capabilities on the V2 envelope (see [Advertising facilitator extensions](#advertising-facilitator-extensions-v2)). |
| `x402.classify(ctx)` | Returns a tagged union: `'no-submission'`, `'rejected'`, `'no-stored-offering'`, `'unmatched'`, `'invalid-shape'`, or `'valid'`. Switch on `kind` to decide what to do. |
| `x402.verify(ctx, classified)` | Calls `facilitator.verify(...)`. Records `status: 'verified'` on success, or `status: 'failed'` with `failure.point: 'verify'` on failure. |
| `x402.settle(ctx, classified, { amountAtomic? })` | Calls `facilitator.settle(...)` and returns a wire-conformant `X402SettleResponse`. Records `status: 'completed'` + the trimmed receipt on success, or `status: 'failed'` with `failure.point: 'settle'` on failure. Pass `amountAtomic` to settle a metered charge under a usage-based scheme (see [Usage-based payments](#usage-based-payments-the-upto-scheme)). |
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
- `receipt` — populated once `status === 'completed'`. Trimmed to `{ transaction, network, payer, amount, settledAt }`, where `amount` is what was actually charged (see [Reconciliation](#reconciliation-the-settled-amount))
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

  async verify(ctx, classified) {
    const start = Date.now();
    try {
      return await super.verify(ctx, classified);
    } finally {
      metrics.histogram('x402.verify.duration_ms', Date.now() - start);
    }
  }

  // Forward `opts` — see the warning below.
  async settle(ctx, classified, opts) {
    const receipt = await super.settle(ctx, classified, opts);
    auditLog.write({ kind: 'x402.settle', taskId: ctx.taskId, receipt });
    return receipt;
  }
}
```

> **If you already subclass `settle`, add the third parameter.** An override
> written against the old two-argument signature silently drops
> `opts.amountAtomic`, so every metered call settles the full offered ceiling
> instead of the metered charge — the clamp cannot help, because the amount
> never reaches it. Accept `opts` and pass it to `super.settle(...)`.

`BaseX402Context` provides concrete implementations for every method, so subclasses only override what they need. `X402Context` is itself a minimal subclass that fills in `store` + `facilitator` defaults; you can model your subclass the same way.

Two `protected` hooks exist for finer-grained extension without reimplementing a whole step: `validatePayloadShape(payload, requirement)` (per-scheme shape checks, called by `classify` before any store write — see [Teaching the pipeline another scheme](#teaching-the-pipeline-another-scheme)) and `meteredRequirement(requirement, payload, amountAtomic)` (the settlement clamp).

### Advanced: stateless helpers without `X402Context`

The low-level helpers `X402Context` is built on remain exported. Reach for them when you want full bespoke control — multiple facilitators, per-request store routing, or a hot-path that bypasses the context's payer-fallback in `settle`:

| Helper | One step it does |
|---|---|
| `x402RequestPayment(input)` | Generator that yields the `request-input` event. Does NOT store anything. |
| `buildX402PaymentRequiredMetadata(input)` | Same metadata, returned as a plain object. |
| `parseX402PaymentSubmission(message)` | Read the x402 status / payload / authorization / `payer` fields off an incoming message. |
| `extractX402Payer(payload)` | Payer address from either signed shape (`authorization.from` or `permit2Authorization.from`). |
| `pickX402Requirement(payload, requirements)` | Find the requirement matching the submitted payload's network + scheme. |
| `validateX402PayloadShape(payload, requirement)` | Local checks, dispatched on the requirement's scheme; returns an array of issues. |
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

### Advertising facilitator extensions (V2)

The V2 `payment-required` envelope carries a top-level `extensions` object the merchant uses to tell the client which optional facilitator capabilities are available for this payment. Pass it as `extensions` on `requestPayment` (or on `x402RequestPayment` / `buildX402PaymentRequiredMetadata`):

```ts
yield* this.x402.requestPayment(context, {
  accepts: ACCEPTS,
  extensions: {
    eip2612GasSponsoring: {},
    erc20ApprovalGasSponsoring: {},
  },
});
```

The concrete payoff is gas sponsoring. `@x402/evm`'s client schemes only sign a **gasless EIP-2612 permit** when `extensions.eip2612GasSponsoring` is present — otherwise the payer falls back to an on-chain `approve(...)` and pays gas for it. Advertise whatever your facilitator reports as supported; the default facilitator (`https://x402.org/facilitator`) reports `builder-code`, `eip2612GasSponsoring`, and `erc20ApprovalGasSponsoring` on `GET /supported`.

This is **V2 only** — the V1 envelope has no `extensions` field, so the option is a no-op on an `x402Version: 1` server. Omit it and the key is left off the wire entirely.

### Usage-based payments (the `upto` scheme)

`exact` charges a fixed price agreed before the work happens. The x402 V2 [`upto` scheme](https://github.com/coinbase/x402/blob/main/specs/schemes/upto/scheme_upto.md) inverts that: the payer signs a **Permit2 witness authorizing up to a maximum**, the merchant does the work, meters it, and settles only what was actually consumed. For an A2A agent the obvious application is billing by LLM token consumption instead of a flat per-call fee.

The merchant flow is the ordinary `X402Context` pipeline with one extra argument at the end:

```ts
const ACCEPTS = [{
  scheme: 'upto',
  network: 'eip155:84532',
  amount: '1000000',                       // the ceiling the payer authorizes (1 USDC)
  asset: USDC_BASE_SEPOLIA,
  payTo: MERCHANT,
  resource: 'https://api.example.com/chat',
  description: 'Metered LLM access — billed per token, up to 1 USDC',
  // `upto` requires the facilitator address the payer's witness binds to.
  // Read it from the facilitator's GET /supported (`extra.facilitatorAddress`).
  extra: { facilitatorAddress: FACILITATOR_ADDRESS },
}];

class MeteredAgent extends BaseAgent {
  async *run(ctx) {
    const classified = await this.x402.classify(ctx);
    if (classified.kind === 'no-submission') {
      yield* this.x402.requestPayment(ctx, { accepts: ACCEPTS, expiresInSeconds: 600 });
      return;
    }
    if (classified.kind !== 'valid') {
      yield this.x402.failedEvent({ code: classified.code, reason: classified.reason });
      return;
    }

    const verify = await this.x402.verify(ctx, classified);
    if (!verify.isValid) { /* … */ return; }

    // Do the work, then meter it.
    const { text, usage } = await this.callModel(ctx.message!);
    const amountAtomic = String(usage.totalTokens * PRICE_PER_TOKEN_ATOMIC);

    const receipt = await this.x402.settle(ctx, classified, { amountAtomic });
    if (!receipt.success) { /* … */ return; }

    yield { type: 'text', role: 'agent', text };
    yield this.x402.completedEvent({ receipt });
  }
}
```

`upto` is a **V2-only** scheme and the SDK enforces that: encoding an `upto` offering under `x402Version: 1` throws a configuration error from `requestPayment`, before anything is persisted. Neither `@x402/core`'s client (which has no V1 registration for it) nor the reference facilitator's Permit2 settlement (which reads V2 fields) has a V1 path, so a V1 upto offer could only dead-end mid-payment. Configure `new X402Context({ x402Version: 2 })`. It is live on the default facilitator (`https://x402.org/facilitator`), which lists an `upto` kind for `eip155:84532` on `GET /supported` with the `extra.facilitatorAddress` your offering must echo. Unlike `exact`, the SDK does **not** synthesize a default `extra` for `upto` — the EIP-712 domain default is meaningless there, so an offering that omits `extra` ships no `extra` at all and the client's signer will refuse it.

#### The clamp guarantee

`amountAtomic` is not forwarded verbatim. `settle` clones the requirement with the amount clamped down to the **minimum** of:

1. `amountAtomic` — what you metered;
2. the amount you offered — your own advertised ceiling;
3. the payer's signed authorization cap (`permit2Authorization.permitted.amount`).

The clamp lives in the SDK on purpose: a metering bug (an off-by-a-decimal token count, a stale price table) can then only ever *undercharge*. Comparison is BigInt, so 30-digit atomic values are exact. `"0"` is a legal charge — zero metered usage settles zero.

`amountAtomic` must be a plain decimal integer string; anything else throws rather than settling an amount nobody computed. This is stricter than `BigInt` on purpose — `BigInt('')` is `0n` and `BigInt('0x10')` is `16`, so an empty meter reading would silently settle nothing and a hex string would settle 16× the intended charge.

Metering an **`exact`** requirement also throws. That scheme binds the payer's signature to one specific value, so a facilitator rejects any settle whose amount disagrees with it — better to fail on the call than after the work is done and the charge has been refused.

The facilitator enforces the same bound on-chain; the SDK clamp is defence in depth, not a substitute for it.

#### What the payer's payload looks like

An `upto` payload carries `permit2Authorization` + `signature` instead of the `exact` scheme's EIP-3009 `authorization` — the `X402UptoEvmPayload` and `X402Permit2Authorization` types (exported from `@a2x/sdk/x402`, alongside `X402ExactEvmPayload` for the EIP-3009 shape) describe it. `classify` dispatches shape validation on the matched requirement and checks the Permit2 equivalents: the signature is present, `witness.to` matches your `payTo` (the binding that stops a signature being replayed to another payee), `permitted.token` matches your `asset`, `permitted.amount` is a positive decimal integer within the offer, and the payer `from` is present. Addresses compare case-insensitively, so a checksummed signature matches a lowercase `payTo`.

> The same Permit2 checks apply to an **`exact`** requirement whose `extra` sets `assetTransferMethod: 'permit2'` — `@x402/evm`'s exact scheme signs a Permit2 witness rather than EIP-3009 for those assets (several of its built-in stablecoins are configured that way), and validating them against EIP-3009 would reject a conformant payment.

`parseX402PaymentSubmission` surfaces both shapes: `submission.authorization` for EIP-3009, `submission.permit2Authorization` for Permit2, and `submission.payer` scheme-agnostically. Receipts backfill `payer` from whichever the payload carries when the facilitator omits it.

Once `classify` has matched a requirement, `payer` is read from the field **that requirement's scheme actually signs** — not sniffed from whichever key is present. `exact` uses its EIP-3009 or Permit2 authorization, `upto` uses its Permit2 authorization, and `batch-settlement` uses `channelConfig.payer`. A payload is client-controlled and may carry decoy authorization objects; without scheme-driven extraction one could name someone else as the payer on the receipt and in your audit store. `extractX402Payer(payload, scheme?)` applies the same dispatch when you drive the pipeline yourself; pass `scheme` whenever you know it.

#### Reconciliation: the settled `amount`

The store entry's receipt carries `amount` and scheme-specific `extra` alongside `transaction` / `network` / `payer` / `settledAt`:

```ts
const entry = await x402.store.get(taskId);
if (entry?.status === 'completed') {
  console.log('charged', entry.receipt!.amount, 'of an authorized', entry.accepts[0]!.amount);
}
```

Under a usage-based scheme this is the key reconciliation datum and it is **not** recoverable from `entry.accepts`, which records the authorized maximum.

For stateful schemes, `extra` is retained in the durable entry as well as the wire receipt. A `batch-settlement` server can therefore recover `extra.channelState` after settling even if the process stops before it emits the terminal A2A event.

It records **only what the facilitator confirmed**. When the facilitator reports no amount (every V1 facilitator, and some V2 ones), the key is absent rather than backfilled from what the SDK asked to settle — a request is not evidence of a settlement, and an audit trail that cannot tell the two apart is worse than one with a gap. Check for the key before relying on it.

#### Teaching the pipeline another scheme

Shape validation is a `protected` hook, so a custom scheme doesn't need the store surgery a `classify` override would:

```ts
class MyContext extends X402Context {
  protected override validatePayloadShape(payload, requirement) {
    if (requirement.scheme === 'my-scheme') return myChecks(payload, requirement);
    return super.validatePayloadShape(payload, requirement);
  }
}
```

`classify` calls the hook **before** anything is written to the store, so returning an empty array leaves the entry at `offered` — no `failed` record to repair.

### Batch settlement (prepaid channels)

`exact` and `upto` both settle on-chain once per call. The x402 V2 [`batch-settlement` scheme](https://github.com/coinbase/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md) removes that from the per-call path: the payer opens and funds an on-chain **channel** once, then each subsequent call costs only an off-chain **cumulative voucher**. The merchant records vouchers as they arrive and redeems many of them in a single transaction, out of band.

That matters when settlement latency sits in the response critical path, and when per-call gas is large relative to per-call value — metering a 1000-token prompt at ~$3/MTok prices the call at ~$0.003, which is not worth an individual on-chain transfer.

#### Merchant side: inject a resource server as the facilitator

**The SDK does not own the batch lifecycle**, deliberately. Voucher accounting is not bookkeeping that fits behind `X402Context.settle()`: it needs cap enforcement against the payer's signed ceiling, a compare-and-set on the cumulative amount, and a request reservation established during *verify* — all of which live in `@x402/evm`'s **server-side** scheme as `@x402/core` lifecycle hooks. Redemption is a separate background concern that must be a singleton across horizontally-scaled deployments, which is not something a library should start on your behalf.

The seam is `facilitator`. `X402Context` accepts any `{ verify, settle }` pair, and `@x402/core`'s `x402ResourceServer` knows how to drive those hooks. Because the resource server is V2-only while the SDK facilitator type covers both x402 versions, narrow the already-V2 context at the adapter boundary:

```ts
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/server';
import { RedisChannelStorage } from '@x402/evm/batch-settlement/server/redis-storage';
import { X402Context } from '@a2x/sdk/x402';

const facilitatorClient = new HTTPFacilitatorClient({ url: 'https://x402.org/facilitator' });

const scheme = new BatchSettlementEvmScheme(MERCHANT, {
  storage: new RedisChannelStorage({ client: redis }),
  receiverAuthorizerSigner,
});

const resourceServer = new x402ResourceServer(facilitatorClient)
  .register('eip155:84532', scheme);
await resourceServer.initialize();

const x402 = new X402Context({
  x402Version: 2,
  facilitator: {
    verify: (payload, requirement) => {
      if (payload.x402Version !== 2 || !('amount' in requirement)) {
        throw new Error('batch-settlement requires x402 V2');
      }
      return resourceServer.verifyPayment(
        payload as unknown as PaymentPayload,
        requirement as unknown as PaymentRequirements,
      );
    },
    settle: (payload, requirement) => {
      if (payload.x402Version !== 2 || !('amount' in requirement)) {
        throw new Error('batch-settlement requires x402 V2');
      }
      return resourceServer.settlePayment(
        payload as unknown as PaymentPayload,
        requirement as unknown as PaymentRequirements,
      );
    },
  },
});
```

Your agent's `run()` is then the ordinary pipeline — `classify` → `verify` → `settle` → `completedEvent` — with no batch-specific code. `X402Context` recognizes both the opening deposit and subsequent voucher-only payload shapes; `settle` returns as soon as the voucher is recorded, so nothing waits on a block.

Redemption stays yours, on whatever cadence suits your economics:

```ts
const manager = scheme.createChannelManager(facilitatorClient, 'eip155:84532');
setInterval(() => manager.claimAndSettle(), 60 * 60 * 1000);   // one singleton, not per-replica
setInterval(() => manager.refundIdleChannels({ idleSecs: 7 * 24 * 60 * 60 }), 24 * 60 * 60 * 1000);
```

Your offering must advertise `extra.receiverAuthorizer` (the address authorized to countersign claims) — the payer's channel id is derived from it, and signing fails without it:

```ts
const ACCEPTS = [{
  scheme: 'batch-settlement',
  network: 'eip155:84532',
  amount: '3000',
  asset: USDC_BASE_SEPOLIA,
  payTo: MERCHANT,
  resource: 'https://api.example.com/chat',
  description: 'Metered access, settled in batches',
  extra: {
    name: 'USDC', version: '2',              // EIP-712 domain for the deposit
    receiverAuthorizer: RECEIVER_AUTHORIZER,
  },
}];
```

`batch-settlement` is V2-only. Configuring this offering on an
`x402Version: 1` context throws before the offering is stored or emitted.

#### Receipts have no transaction hash

A successful voucher settlement returns `success: true` with an **empty** `transaction` — there is no chain write to name yet. Do not read an empty `transaction` as failure; branch on `success`.

What it carries instead is `receipt.extra`, the scheme's post-settlement state, forwarded verbatim from the facilitator:

```ts
receipt.extra?.channelState   // { channelId, balance, totalClaimed, chargedCumulativeAmount, … }
```

`exact` and `upto` never populate `extra`. It exists because the payer cannot function without it — see below.

`receipt.amount` reports the per-call service charge, taken from the facilitator's `extra.chargedAmount`. The facilitator's own top-level `amount` names the immediate transfer instead — empty for an off-chain voucher, the whole funding total for a deposit payload — neither of which is what the call settled for.

#### Payer side: storage is not optional

Unlike `exact` and `upto`, the payer here is **stateful**, so the scheme is registered only when you supply its config:

```ts
import { A2XClient } from '@a2x/sdk/client';

const client = new A2XClient(url, {
  x402: {
    signer,
    batchSettlement: { storage: myChannelStorage },
    allowBatchSettlement: true,
  },
});
```

`storage` is required and has deliberately no default. a2x types its signer as a viem `LocalAccount`, which has no `readContract`, so `@x402/evm`'s on-chain channel recovery never runs — **this storage is the only record that a channel exists**. If it comes back empty against a channel that is already funded, the next call signs a fresh deposit into it: real funds moved, on top of a balance you already have. Implement `X402ClientChannelStorage` over whatever you already persist:

```ts
import type { X402ClientChannelStorage } from '@a2x/sdk/x402';

const myChannelStorage: X402ClientChannelStorage = {
  get:    (key)        => db.channels.findUnique({ where: { key } }),
  set:    (key, state) => db.channels.upsert({ where: { key }, create: { key, ...state }, update: state }),
  delete: (key)        => db.channels.delete({ where: { key } }),
};
```

The requirement is enforced at runtime as well as by TypeScript. Supplying an empty config, `storage: undefined`, or an object without callable `get`, `set`, and `delete` methods throws `X402PaymentRequiredError` before the upstream scheme is constructed. It never selects `@x402/evm`'s in-memory fallback accidentally across a plain-JavaScript or unchecked configuration boundary.

`@x402/evm` ships `InMemoryClientChannelStorage` and a file-backed one under `@x402/evm/batch-settlement/client/file-storage`; the in-memory one is for tests and short-lived scripts only.

Deposit sizing defaults to 5× the request amount, so one funding covers the next four calls. Tune it with `depositPolicy` (`depositMultiplier`, an integer ≥ 3) or take full control per deposit with `depositStrategy`:

```ts
batchSettlement: {
  storage: myChannelStorage,
  depositPolicy: { depositMultiplier: 20 },
  depositStrategy: ({ requestAmount, minimumDepositAmount, depositAmount }) => {
    if (BigInt(requestAmount) > MAX_PER_CALL) return false;   // skip: sign a voucher-only payload
    return depositAmount;                                     // or any amount >= minimumDepositAmount
  },
},
```

`maxAmount` bounds the **deposit**, not just the per-request amount:

1. **Before selection** — the per-request amount is filtered against the cap like every other scheme. A multiplier outside `@x402/evm`'s accepted range (integers ≥ 3) also fails closed here rather than leaking a generic scheme-construction error.
2. **At signing** — after the scheme derives the channel id and reads storage, any deposit it actually sizes is checked before it is signed, including one a `depositStrategy` returned and the policy amount a strategy defers to with `undefined`. Exceeding the cap throws rather than silently authorizing.

The second check cannot be replaced with a static `depositMultiplier x amount` filter. A channel may already have enough balance, in which case the same request emits a voucher-only payload and authorizes no new deposit; rejecting it by the opening-deposit estimate would make `maxAmount` disable the channel after it was funded. Conversely, when initial funding or a top-up is required, the signing hook sees the exact amount the peer is about to authorize and keeps the cap authoritative.

#### Reconciliation is mandatory

`@x402/evm` normally advances the payer's channel state from its own HTTP client's `onPaymentResponse` hook, reading the `PAYMENT-RESPONSE` header. **a2x carries payments over A2A task metadata and never runs that hook**, so the step is explicit.

`A2XClient` does it for you on both the blocking and streaming paths, bound to **what that exchange actually signed**: the channel, and the cumulative ceiling its voucher authorized. Both halves are a security boundary, not an optimization.

- **The channel id.** Ids derive from public inputs, so the one you share with any given merchant is computable by anyone — and a receipt names the channel it updates. Without this, a merchant you *did* pay could name a channel belonging to a **different** merchant and overwrite its cumulative, bricking it or forcing an invalid top-up.
- **The ceiling.** Without it, the same merchant can inflate its *own* channel instead: report 5000 back after a 1000 voucher, and your next 1000 call signs a 6000 cumulative plus a top-up to cover it — letting the merchant claim far more than the calls cost. A figure above the ceiling was never authorized and is always refused. Below it, two shapes are honest and validated exactly. A **metered** receipt carries `extra.chargedAmount` — the server settled via `X402Context.settle({ amountAtomic })`, so the cumulative advanced by only the actual charge — and is accepted only when it reports exactly `pre-attempt cumulative + chargedAmount`; the fold then commits that reported figure. An **unmetered** receipt (no usable `chargedAmount`) must report the ceiling exactly, because the plain lifecycle advances by the full offered amount that verify pinned the ceiling to; a smaller value there is stale and could let an old receipt mask this exchange while the merchant retains the higher-value voucher. A receipt with **no** cumulative at all is also refused — it would perform a partial write that leaves the signing base where it was, which for a spent voucher is a desync rather than a no-op.
- **The deposit and the snapshot.** A merchant reporting `balance: "0"` every round makes the scheme treat the channel as unfunded and sign a fresh deposit every round. `maxAmount` does not stop that — it caps each deposit individually, not their aggregate. Within a payment flow the channel balance only ever goes up, by exactly the deposits you sign, so a reported balance below `pre-attempt balance + this deposit` is one the merchant could not have reached honestly, and it is **replaced** by that floor. The floor's base is the **pre-attempt snapshot** captured when the payload was signed, not whatever storage holds when the receipt is folded: after a torn or failed write, the stored record is precisely the thing that cannot be trusted. A balance *above* the floor is kept: overstating can only make you under-fund a later call, which costs you nothing.

Two cases `A2XClient` does not cover, where you reconcile yourself — and must supply the same binding:

```ts
import {
  reconcileX402BatchSettlement,
  getX402Receipts,
} from '@a2x/sdk/x402';

// (a) You drove the dance manually with `signX402Payment`.
// (b) The receipt reached you via `getTask` rather than the send that paid.
const signed = await signX402Payment(task, {
  signer,
  batchSettlement,
  allowBatchSettlement: true,
});
// `signed.batch` is the complete binding: channel, voucher ceiling, deposit,
// and the trusted pre-attempt snapshot read right after signing.
// …resubmit with `signed.metadata`, then on the terminal task:
const { applied } = await reconcileX402BatchSettlement(getX402Receipts(final), {
  storage: myChannelStorage,
  bindings: signed.batch!,
});
if (applied.length === 0) {
  // The voucher is spent and local state did not move — see below.
}
```

Persist `signed.batch` alongside the payload if reconciliation may happen in a later process: the snapshot cannot be reconstructed afterwards. A caller resuming from a persisted *payload* alone can rebuild the payload-provable half with `getX402BatchSettlementBinding(payload)`, but must combine it with the snapshot it captured at signing time to form the `bindings` entry.

Skip reconciliation and the payer's cumulative amount never advances: every subsequent call re-signs an identical voucher against a channel it still believes is unfunded — and therefore signs a **fresh deposit** each time. Receipts from other schemes, malformed ones (including non-object array entries), any naming a channel outside `bindings`, and any whose cumulative differs from the signed ceiling are ignored; a receipt that fails to apply raises an `AggregateError` after the others have been tried, so one bad entry cannot drop a good one.

When `bindings` is an array, every entry must name a distinct channel. Reconcile successive attempts on the same channel separately; collapsing them into one call would lose which deposit floor belongs to which cumulative voucher. Reconciliation calls through the same storage object are serialized per channel inside the process, so a delayed older receipt cannot overwrite a newer cumulative.

The write itself is a **deterministic fold**: `trusted snapshot + binding + receipt → next state`, computed without reading the record being replaced. That makes retries exact rather than best-effort — re-running the same binding and receipt rewrites the same state, so a torn write (cumulative committed without the balance, or the reverse) is repaired by simply reconciling again, for deposits and voucher-only payments alike. A successful fold also clears any quarantine marker on the record, which is the documented repair path for a quarantined channel.

That receipt lock alone cannot make concurrent signing safe: `@x402/evm` only reads storage while it creates a payload and does not reserve the next cumulative or deposit. Two overlapping attempts can therefore read the same empty state and each authorize a fresh deposit before either receipt exists. `A2XClient` prevents this in-process by holding one lease per storage object across the complete sign → submit → reconcile/quarantine lifetime (conservatively serializing different channels that share that object because the channel id is not available until after signing). If the lease holder is quarantined, attempts already queued behind it are rejected with the same `X402ReconciliationError` before they can sign from stale storage; repair or retire the channel before retrying. The low-level helpers cannot retain a lock across your network call, so manual flows must serialize that entire lifetime per channel themselves. The storage interface has no cross-process compare-and-set operation; when multiple processes or replicas share a backend, route each channel through one owner or add an application-level durable reservation before signing.

**An empty `applied` after a settled payment is a failure, not a no-op.** The voucher is spent either way, so "nothing to record" and "the merchant withheld or falsified the receipt" have identical consequences: local state did not move, and the next call re-signs or re-deposits. `A2XClient` raises `X402ReconciliationError` with `reason: 'no-matching-receipt'` in that case; a caller driving the helper directly should treat it the same way.

The SDK also fails closed when the merchant returns any terminal A2A task (`completed`, `failed`, `canceled`, or `rejected`) but omits a usable receipt. Settlement can succeed before agent execution later fails, and once the payer handed over a voucher the merchant may retain and redeem it; neither a remote status marker nor the task's final state can prove that local channel state is safe to reuse.

The binding becomes outstanding as soon as the signed submission is handed to the transport. If blocking transport/JSON parsing fails, a non-blocking unary call returns an intermediate task, a follow-up SSE stream errors or is aborted, the caller closes that stream early, or the stream reaches EOF before a receipt or a complete retry prompt, `A2XClient` raises the same quarantine error with `reason: 'ambiguous-response'`. A status marker alone is not a retry prompt: `x402.payment.required` must also be present before the client treats the previous voucher as rejected. A known intermediate unary response is available as `task`; transport failures and streaming exits have no complete task, and the original transport/stream failure is available as `cause` when one occurred. In every case the merchant must be assumed to hold the voucher until an operator reconciles or retires the channel.

A matching success receipt takes precedence over a contradictory retry prompt anywhere later in the same response stream, whether it appears in the same event or a separate event. Once that receipt advances durable channel state, `A2XClient` does not sign again for the call; doing so would authorize the same work twice. This batch-only guard does not change `exact` or `upto` retry behavior.

#### A missed receipt does not self-heal

The merchant requires the next voucher's cumulative to equal exactly `charged + amount`, and `@x402/evm`'s corrective-recovery path needs a signer with `readContract`, which a viem `LocalAccount` does not have. A payer that loses a receipt stays desynced until its storage is repaired out of band, and the next call can sign a fresh on-chain deposit.

Because that is a funds-bearing failure, `A2XClient` **throws** `X402ReconciliationError` rather than continuing quietly — an operator who is never told cannot quarantine the channel first. It carries `channelId`, the merchant's terminal `task` when available, and a `reason`: `write-failed` (your storage threw — usually transient), `no-matching-receipt` (a terminal task arrived but nothing was recorded), or `ambiguous-response` (the response ended before either safe outcome was known). When present, `task` means catching the error still leaves you the result the merchant produced — including on the streaming path, where reconciliation runs before the terminal event is yielded and a throw means you never see that event:

```ts
try {
  const task = await client.sendMessage({ message });
} catch (err) {
  if (err instanceof X402ReconciliationError) {
    await quarantineChannel(err.channelId);
    if (err.task) return err.task as Task;
    // No task means the response was ambiguous; quarantine before retrying.
  }
  throw err;
}
```

Prefer the originating call to record and continue? Supply a handler:

```ts
x402: {
  signer,
  batchSettlement: { storage },
  allowBatchSettlement: true,
  onReconcileError: async (err) => {
    await pageOperator(err);
    await quarantineChannel(err.channelId);
  },
}
```

The handler does not release already-queued calls to sign from stale storage. Those callers are rejected with the same reconciliation error before payload creation, so repair or retire the channel before retrying them.

#### Quarantine survives a restart

The in-process rejection above dies with the process. To stop a restarted payer from signing a fresh deposit out of the same desynced storage, the SDK also **persists** the quarantine: alongside raising `X402ReconciliationError` it best-effort writes `quarantinedAt` / `quarantineReason` onto the channel's stored record. While that marker is present, signing against the channel throws `X402ChannelQuarantinedError` — before the payload ever reaches the merchant.

Two ways to lift it:

- **Repair**: re-run `reconcileX402BatchSettlement` with the attempt's binding and the receipt (fetched via `getTask` if the original response was lost). A successful fold rewrites the exact post-attempt state and clears the marker.
- **Manual**: after verifying the stored state out of band, remove the `quarantinedAt` / `quarantineReason` keys yourself.

The marker write is advisory — when storage itself is what failed, it fails too, and the raised error plus the in-process abort remain the guarantee.

#### Selection is opt-in, and separate from `allowUpto`

The default selector never picks `batch-settlement` on its own. `allowBatchSettlement` is its own flag rather than part of `allowUpto` because the consent differs in kind: `upto` widens *how much* of an authorization the merchant may draw, while funding a channel moves money **before any service is rendered**, recoverable only through a cooperative refund or the idle-channel path.

Preference order under the default selector is `exact` → `upto` → `batch-settlement`: the widest consent wins only when nothing narrower is on offer. Like `upto`, it is V2-only and requires a CAIP-2 network, and an explicit `selectRequirement` bypasses the flag entirely (but still needs `batchSettlement` configured, or the scheme was never registered).

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

Every receipt carries a `payer` field per x402-v1 §5.3.2. A V2 facilitator may
also report `amount` — the amount actually settled, in the asset's smallest unit
— and the SDK passes it through onto the receipt. This covers the success
receipt and failure receipts built from a structured `success: false` response
body; when a facilitator rejects settlement with a non-2xx status, `@x402/core`
surfaces it as a thrown error that does not preserve `amount`, so those failure
receipts cannot carry it. For the `exact` scheme it equals the offered
amount; under usage-based schemes it is the metered charge and can be less than
the signed authorization, so it is the payer's record of what they were charged.
V1 facilitators never set it, so the field is absent on V1 receipts. Failures
surface under `x402.payment.error` with one of the codes below.

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
| `selectRequirement` | first EVM `scheme === 'exact'` | Predicate over the (already filtered) requirements. Return `undefined` to abort. |
| `allowUpto` | `false` | Let the default selector fall back to an EVM `upto` offer when no `exact` one fits. See [Paying an `upto` offer](#paying-an-upto-offer). |
| `onPaymentRequired` | none | Hook between `payment-required` and signing. Return `false` to send `payment-rejected` cleanly; throw to abort *locally* without telling the merchant. |
| `maxRetries` | `0` | Additional sign+resubmit attempts when the merchant re-issues a complete `payment-required` envelope on the same task. A reconciled batch attempt is never paid again. |

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

### Paying an `upto` offer

The signing runtime registers `@x402/evm`'s `upto` client scheme alongside `exact`, so an `upto` offer *can* be signed. **The default selector will not choose one on its own**, and that is deliberate.

Signing `exact` authorizes one amount and nothing else. Signing `upto` authorizes the merchant to draw **anything up to** the offered amount, at its discretion, after the fact. Silently upgrading a wallet from the first to the second changes what the payer consented to, so the SDK refuses to make that substitution unprompted — the server-side [clamp](#the-clamp-guarantee) is the merchant's own guard rail, not a promise to the payer. `X402NoSupportedRequirementError` is what you get if `upto` is the only offer and you did not opt in.

The fallback additionally requires a **CAIP-2** network (`eip155:<chainId>`). `upto` is V2-only, so a bare-name V1 offer is never eligible however it is advertised.

Two ways to pay one:

```ts
// (a) Opt the default selector into the fallback. A payable `exact` offer
//     still wins; `upto` is only used when none fits. `maxAmount` still
//     applies — it bounds the authorized maximum.
const client = new A2XClient(url, {
  x402: { signer, maxAmount: 1_000_000n, allowUpto: true },
});

// (b) Choose it explicitly. An explicit selector is the caller's own
//     decision, so `allowUpto` is not consulted.
const signed = await signX402Payment(task, {
  signer,
  selectRequirement: (reqs) => reqs.find((r) => r.scheme === 'upto'),
});
```

Either way the payer's receipt carries `amount` — what they were actually charged, which can be less than what they authorized.

### Reading advertised extensions

`getX402PaymentExtensions(task)` returns the V2 envelope's top-level `extensions` — the facilitator capabilities the merchant advertised (see [Advertising facilitator extensions](#advertising-facilitator-extensions-v2)). Hand it to `@x402/core` as the `PaymentPayloadContext` extensions when you drive signing yourself:

```ts
import { getX402PaymentExtensions } from '@a2x/sdk/x402';

const extensions = getX402PaymentExtensions(first);
if (extensions?.eip2612GasSponsoring) {
  // the facilitator will sponsor the permit — no on-chain approve needed
}
```

Returns `undefined` for a V1 envelope (which has no such field), for a V2 envelope that advertised nothing, and for a task that isn't asking for payment. `signX402Payment` and the built-in `A2XClient` flow already forward the field to the signing runtime, so this helper is only needed when you inspect or re-route it yourself.

### Reading receipts

```ts
import { getX402Receipts } from '@a2x/sdk/x402';

for (const receipt of getX402Receipts(task)) {
  console.log(receipt.success, receipt.transaction, receipt.network);
  // Present only when the facilitator reported a settled amount (x402 V2).
  if (receipt.amount !== undefined) console.log('charged:', receipt.amount);
  // Scheme-specific settlement state. `exact` / `upto` never set it;
  // `batch-settlement` reports `extra.channelState`.
  if (receipt.extra) console.log('scheme state:', receipt.extra);
}
```

`transaction` is empty on failure — **and also on a successful settlement under a scheme that does not touch the chain per call**, such as a `batch-settlement` voucher. Branch on `success`, never on whether `transaction` is populated.

## Server-side enforcement

Per spec §8, x402-capable clients MUST include the extension URI in the `X-A2A-Extensions` HTTP header on every JSON-RPC request:

```
X-A2A-Extensions: https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2
```

When the merchant agent declares the extension with `required: true` on its AgentCard, `DefaultRequestHandler` rejects requests whose header doesn't list that URI (error `-32600`). The check only runs when a `RequestContext` is provided to `handler.handle()` — pure in-process invocations skip it.

## Supported scope

- **Both x402 protocol versions** (V1 `x402Version: 1` and V2 `x402Version: 2`). The server emits the one its deployment configured; the client signs whichever it receives.
- **Standalone Flow.** The Embedded Flow (x402 nested in an AP2 `CartMandate` / `PaymentMandate`) and its signing models are not implemented in either version — those were described in a2a-x402 v0.2 but have no counterpart in the foundation V2 transport, so their V2 semantics are currently undefined.
- **`exact`, `upto`, and `batch-settlement` schemes, EVM networks** (`base`, `base-sepolia`, `polygon`, `avalanche`, …). `upto` and `batch-settlement` are V2-only and require `@x402/evm` ≥ 2.20 (the declared peer floor); the client auto-selects neither (see [Paying an `upto` offer](#paying-an-upto-offer) and [Batch settlement](#batch-settlement-prepaid-channels)). For `batch-settlement` the SDK covers the **payer** end-to-end; the merchant end is wired by injecting an `x402ResourceServer` as the facilitator, and redemption stays out of the SDK. Other schemes pass through the pipeline untouched — override `BaseX402Context.validatePayloadShape` to validate them. Adding Solana support means passing a Solana-compatible signer in a later release.

## Reference

- V2 transport (in-repo, vendored from the x402 Foundation): [`specification/x402-transport-a2a-v2.md`](https://github.com/planetarium/a2x/blob/main/specification/x402-transport-a2a-v2.md)
- V1 lineage: [`specification/x402-transport-a2a-v1.md`](https://github.com/planetarium/a2x/blob/main/specification/x402-transport-a2a-v1.md), [`specification/a2a-x402-v0.2.md`](https://github.com/planetarium/a2x/blob/main/specification/a2a-x402-v0.2.md), [`specification/x402-v1.md`](https://github.com/planetarium/a2x/blob/main/specification/x402-v1.md)
- Migration (SDK API, not protocol): [Migrating off `x402PaymentHook`](./migration-x402-v2.md)
