# x402 Payments

Charge per call with on-chain cryptocurrency payments. A2X implements the x402 A2A transport on top of A2A tasks, speaking **both versions** of the x402 protocol on the wire: the legacy V1 envelopes ([a2a-x402 v0.2](https://github.com/google-agentic-commerce/a2a-x402/blob/main/spec/v0.2/spec.md)) and the V2 envelopes defined by the [x402 Foundation A2A transport](https://github.com/x402-foundation/x402/blob/main/specs/transports-v2/a2a.md).

The flow: the merchant agent responds to an unpaid request with `input-required` + `x402.payment.required`. The client signs a `PaymentPayload` with its wallet and resubmits the same task. The merchant validates the payload, verifies it via an x402 **facilitator**, settles on-chain, and attaches the settlement receipt to the completed task. This flow is identical across versions — only the JSON envelope shapes differ (see [Protocol versions](#protocol-versions-v1--v2)).

> **Flow ownership.** The `@a2x/sdk/x402` entry exposes each protocol mechanic separately and an explicit host-neutral `MerchantGate` composition described below. Nothing installs or schedules a payment flow automatically. The merchant still supplies paid/free selection, rates, settlement timing, missing-usage behavior, and event rendering. The previous framework-owned `x402PaymentHook` / `inputRoundTripHooks` API remains removed; see [Migrating from X402PaymentExecutor / x402PaymentHook](./migration-x402-v2.md).

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
- `receipt` — populated once `status === 'completed'`. Trimmed to `{ transaction, network, payer, amount, extra, settledAt }`, where `amount` is what was actually charged (see [Reconciliation](#reconciliation-the-settled-amount)) and `extra` is the facilitator's optional scheme-specific settlement state — `batch-settlement` puts `channelState` there, and a custom durable store that trims it loses the recovery data batch reconciliation depends on
- `failure` — populated once `status === 'failed'` or `'rejected'`. Contains `{ point, code, reason, failedAt }`

`failure.point` identifies where the round-trip broke:

| `point` value | When |
|---|---|
| `'classify'` | Submission was invalid before facilitator was called (no offering / unmatched / shape error) |
| `'verify'` | `facilitator.verify` returned `isValid: false` |
| `'settle'` | `facilitator.settle` returned `success: false` |
| `'rejected-by-client'` | Client sent `x402.payment.status: payment-rejected` |

When settlement throws instead of returning a structured refusal, `failure.indeterminate` is `true`: the request may have reached the facilitator and must be reconciled before retry.

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

`BaseX402Store.updateIfStatus(taskId, expected, patch)` prevents a late concurrent verify/classify result from regressing `completed` or `rejected` state. Its base implementation is a source-compatible read-then-update fallback. Multi-replica stores MUST override it with an atomic compare-and-set.

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

### Shared merchant-policy gate

Use `MerchantGate` when more than one host needs the same payment policy but renders different event types. It consumes `X402Context` and returns plain outcomes while sharing the same optional `@a2x/sdk/x402` entry:

Protocol refusals from `X402Context.requestPayment()` remain explicit outcomes. For example, a V2 server receiving the legacy V1-only activation URI returns `refuse` with `invalid_x402_version`; the gate does not replace it with a generic infrastructure failure.

```ts
import { MerchantGate, X402Context } from '@a2x/sdk/x402';

const gate = new MerchantGate({
  x402: new X402Context({ x402Version: 2 }),
  exactTiming: 'after-work', // required: the SDK does not choose the risk allocation
  onError: (error, { operation, taskId }) => {
    logger.error({ error, operation, taskId }, 'x402 merchant operation failed');
  },
  pricing: async ({ taskId, contextId, message }) => {
    const row = await pricingRepository.forRequest({ taskId, contextId, message });
    if (!row) return null; // this request is free
    return {
      expiresInSeconds: 600,
      accepts: [{
        scheme: 'upto',
        network: row.network,
        maxAmount: row.maxAmount,
        minAmount: row.minAmount,
        asset: row.asset,
        payTo: row.payTo,
        resource: row.resource,
        description: row.description,
        extra: { facilitatorAddress: row.facilitatorAddress },
        rates: {
          inputPerMillion: row.inputPerMillion,
          outputPerMillion: row.outputPerMillion,
          cachedInputPerMillion: row.cachedInputPerMillion,
        },
        unreportedUsage: 'refuse', // also required: ceiling/floor/refuse are merchant policy
      }],
    };
  },
});
```

On the inbound turn, translate the outcome into the host's event system:

```ts
const opened = await gate.open({
  taskId: ctx.taskId!,
  contextId: ctx.contextId,
  // Omitted or undefined messages are treated as an unpaid first turn.
  message: ctx.message,
  activatedExtensions: ctx.activatedExtensions,
});

if (opened.kind === 'request-payment') {
  yield { type: 'request-input', message: opened.text, metadata: opened.metadata };
  return;
}
if (opened.kind === 'refuse') {
  yield x402.failedEvent(opened);
  return;
}
if (opened.kind === 'handled') {
  // A self-contained operation such as a cooperative batch refund has
  // already settled and must bypass resource work.
  yield { type: 'done', metadata: opened.receiptMetadata };
  return;
}

if (!opened.obligation) {
  const result = await runWork();
  yield { type: 'text', role: 'agent', text: result.text };
  yield { type: 'done' };
  return;
}

let result;
let settled;
try {
  result = await runWork();
  settled = await gate.settle({
    taskId: ctx.taskId!,
    obligation: opened.obligation,
    usage: result.usageAvailable
      ? {
          kind: 'detailed',
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cachedInputTokens: result.cachedInputTokens,
        }
      : { kind: 'unreported' },
  });
} catch (error) {
  await gate.abort({
    taskId: ctx.taskId!,
    obligation: opened.obligation,
    reason: 'handler_threw',
    error,
  });
  throw error;
}
if (settled.kind === 'failed') {
  yield x402.failedEvent(settled);
  return;
}
yield { type: 'text', role: 'agent', text: result.text };
yield { type: 'done', metadata: settled.receiptMetadata };
```

The pricing callback runs only on the unpaid turn. Its complete `MerchantOffer` is frozen by the offer store and the submitted turn settles against that snapshot, not live rates. When `expiresInSeconds` is omitted, `MerchantGate` applies a 10-minute TTL to both the offer-store snapshot and the underlying x402 offering; set `expiresInSeconds` on the offer to override it. The default `InMemoryMerchantOfferStore` independently defaults to the same TTL and caps itself at 10,000 live entries. Standalone store users can override those limits with `defaultTtlSeconds` and `maxEntries`. It also grants an execution claim. Multi-replica deployments must inject a durable `MerchantOfferStore` whose publication, claim, and release operations are atomic and whose claim status is shared across replicas.

Verification happens before the execution claim is consumed, so a transient verification failure can be retried on the same task. Once verification succeeds, only one concurrent caller receives the claim and may execute work. Exact and `upto` remain one-shot after that claim. A canceled `batch-settlement` obligation releases both the task claim and the official scheme's channel reservation, so the same voucher can retry after failed work. Cleanup failures do not turn a completed payment into a failure; they are reported through `onError` with `operation: 'cleanup'`.

Successful settlement now removes the frozen merchant offer but retains the completed `X402StoreEntry` until its configured TTL. This gives every scheme a durable completed-replay answer and keeps its reconciliation receipt available. The lifecycle store must therefore have a bounded TTL and an operational expiry sweep when its backend does not expire rows natively.

If one object implements both `MerchantOfferStore` and the x402 lifecycle store, it must implement `deleteOffer()` so cleanup can remove merchant terms without deleting the retained lifecycle entry. `MerchantGate` reports a cleanup configuration error through `onError` and retains both records when that method is missing; it never deletes completed reconciliation evidence to compensate for a misconfigured combined store.

#### Replay and crash-recovery policy

`MerchantGate` combines the x402 lifecycle entry with the offer store's claim; it does not add a new `X402Classification` variant. Exhaustive switches over `X402Classification` remain source-compatible. `MerchantOfferStore.getClaimStatus()` is an optional read-only fast path: a `claimed` result avoids a facilitator verify call, while an `available` result never grants execution. The post-verify `claim()` compare-and-set remains the arbiter under races.

`BaseX402Context.classify()` remains a protocol-shape classifier, not an execution-policy lock. Direct low-level callers that do not use `MerchantGate` must inspect `x402.store` and provide their own nonce/execution claim before running work. `updateIfStatus()` protects lifecycle audit state from late writes; it does not by itself prevent a second facilitator call.

| Lifecycle state | Durable claim | Gate behavior |
|---|---|---|
| `offered` | available | Normal submission flow. |
| `failed` at classify or verify | available | Recoverable: a corrected submission can verify and compete for the claim. |
| `verified` | available | Recoverable after a crash that happened before execution was claimed; verification runs again. |
| `verified` or `failed` | claimed | Terminal for automatic replay. Work may be running, may have had side effects, or settlement may be uncertain. |
| `rejected` | either | Terminal for that task because the payer explicitly declined its terms. |
| `completed` | either/absent | Terminal; the retained receipt proves settlement and verification is skipped. |
| expired/absent | absent | A submitted payment has no stored offering; an unpaid turn may create a new offer. |

Two concurrent submissions can both observe `available` and both verify. Exactly one wins the later atomic `claim()`; every loser cancels any scheme reservation and receives `DUPLICATE_NONCE`. This is why `getClaimStatus()` is never a lock.

A facilitator response with `success: false` is a definitive settlement refusal. In `before-work` mode the gate can delete both records and allow the task to restart. A thrown settlement transport/schema error is different: the transfer may already have been broadcast. `X402EntryFailure.indeterminate` is then `true`, and the claim is kept until expiry or explicit operator reconciliation. Only call `offerStore.release(taskId)` after proving that neither resource side effects nor settlement occurred. Batch abort remains the normal automatic release path because it also cancels the scheme reservation.

Unexpected exceptions that escape pricing, storage, or x402 operations are never copied into payer-facing refusal reasons. `open()` and `settle()` return fixed generic text and pass the original error to the optional `onError` callback for host-side logging. Structured verification and settlement failures keep their protocol reason and failure receipt.

Usage is semantic rather than inferred. A trusted zero reading is `{ kind: 'total', totalTokens: 0 }` and charges zero; a runtime that uses zero counters as an “accounting unavailable” sentinel must normalize them to `{ kind: 'unreported' }`. Each `rates` object must use exactly one form: detailed input/output rates or `totalPerThousand`. Detailed rates cannot price a total-only reading, so that combination also follows the offer's required `unreportedUsage` policy. A `totalPerThousand` rate can price either usage shape.

`exactTiming` is required because `before-work` protects the merchant from delivering work whose authorization later fails, while `after-work` protects the payer from being charged for work that fails. For `before-work`, `open()` returns an already-settled obligation; calling `settle()` after the work reuses its receipt and never charges twice. If the facilitator definitively refuses settlement before work, the gate clears the frozen offer and execution claim so the payer can restart the payment flow on the same task. An indeterminate transport failure keeps the claim, as described above.

On success, `settled.charge.requestedAtomic` is the amount the gate asked the facilitator to settle. `settled.charge.amountAtomic` is the facilitator-reported `receipt.amount` when it is a decimal amount, or the requested amount when the receipt omits it. Comparing the two surfaces settlement reconciliation mismatches without discarding the facilitator's authoritative value.

Each offer must contain unique payment identities across scheme, normalized network, asset, payee, and amount. Duplicate entries fail during turn-1 validation instead of making an otherwise valid turn-2 payment ambiguous.

### Session-scoped `upto` metering

An `upto` authorization is single-use: settling one turn consumes it even when the charge is far below the signed cap. `UptoSessionManager` can instead hold that verified authorization across one A2A `contextId`, meter multiple turns, and call the same `MerchantGate.settle()` exactly once when the conversation becomes idle, reaches its budget, approaches the signed deadline, or is closed by the host.

The wire scheme remains `upto`; clients do not need a session-specific signer or payload. Session mode is merchant policy and is never enabled automatically.

```ts
import {
  InMemoryUptoSessionStore,
  MerchantGate,
  UptoSessionManager,
} from '@a2x/sdk/x402';

const sessionStore = new InMemoryUptoSessionStore();
let sessions!: UptoSessionManager;

const gate = new MerchantGate({
  x402,
  exactTiming: 'after-work',
  pricing: async (turn) => {
    // Active conversations already hold a verified authorization.
    if (turn.contextId && await sessions.active(turn.contextId)) return null;
    return pricingRepository.offerFor(turn);
  },
});

sessions = new UptoSessionManager({
  gate,
  store: sessionStore,
  idleSeconds: 120,
  maxDurationSeconds: 600,
  deadlineGuardSeconds: 30,
  onError: (error, context) => logger.error({ error, context }),
});

const recovery = await sessions.recover();
for (const unresolved of recovery.unresolved) {
  // No timer is armed for unresolved work. Reconcile every id before serving traffic.
  for (const turnId of unresolved.pendingTurnIds) {
    const evidence = await taskRepository.lookupTurn(turnId);
    if (evidence.usage) {
      if (unresolved.turns === 0 && turnId === unresolved.taskId) {
        await sessions.commitOpen({
          contextId: unresolved.contextId,
          taskId: turnId,
          usage: evidence.usage,
        });
      } else {
        await sessions.finishTurn({
          contextId: unresolved.contextId,
          turnId,
          usage: evidence.usage,
        });
      }
    } else if (evidence.provesNoBillableWork) {
      if (unresolved.turns === 0 && turnId === unresolved.taskId) {
        await sessions.cancelOpen({ contextId: unresolved.contextId, taskId: turnId });
      } else {
        await sessions.cancelTurn({ contextId: unresolved.contextId, turnId });
      }
    } else {
      alertReconciliationQueue(unresolved);
    }
  }
}
```

Reserve an already-active session before starting work. The stable `turnId` makes completion idempotent, and the lease stops idle/deadline triggers from settling between the active-session check and usage recording:

```ts
const contextId = ctx.contextId;
const turnId = ctx.message.messageId;
const lease = contextId
  ? await sessions.beginTurn({ contextId, turnId })
  : { kind: 'inactive' as const };

if (lease.kind === 'duplicate') {
  // Reuse the host's durable turn result; never execute or meter it twice.
  yield await replayTurnResult(turnId, lease.status);
  return;
}
const leased = lease.kind === 'started';

const opened = await gate.open({
  taskId: ctx.taskId!,
  contextId,
  message: ctx.message,
  activatedExtensions: ctx.activatedExtensions,
});

if (opened.kind !== 'proceed') {
  if (leased && contextId) await sessions.cancelTurn({ contextId, turnId });
  yield renderMerchantOutcome(opened);
  return;
}

const openingObligation =
  !leased &&
  contextId &&
  opened.obligation?.kind === 'deferred' &&
  opened.obligation.scheme === 'upto'
    ? opened.obligation
    : undefined;
let openingReserved = false;
if (openingObligation) {
  const reservation = await sessions.reserveOpen({
    contextId,
    taskId: ctx.taskId!,
    obligation: openingObligation,
  });
  if (reservation.kind === 'duplicate') {
    yield await replayTurnResult(ctx.taskId!, reservation.status);
    return;
  }
  if (reservation.kind === 'unavailable') {
    // The manager already lapsed this task's unused authorization.
    yield renderOpeningUnavailable(reservation.reason);
    return;
  }
  openingReserved = true;
}

let result;
try {
  result = await runWork();
} catch (error) {
  if (leased && contextId) {
    await sessions.cancelTurn({ contextId, turnId });
  } else if (openingReserved && contextId) {
    await sessions.cancelOpen({ contextId, taskId: ctx.taskId! });
  } else if (openingObligation) {
    await gate.lapse(ctx.taskId!);
  } else if (opened.obligation) {
    await gate.abort({
      taskId: ctx.taskId!,
      obligation: opened.obligation,
      reason: 'handler_threw',
      error,
    });
  }
  throw error;
}

const usage = result.usageAvailable
  ? { kind: 'total' as const, totalTokens: result.totalTokens }
  : { kind: 'unreported' as const };

let sessionOutcome;
if (leased && contextId) {
  sessionOutcome = await sessions.finishTurn({ contextId, turnId, usage });
} else if (openingReserved && contextId) {
  sessionOutcome = await sessions.commitOpen({
    contextId,
    taskId: ctx.taskId!,
    usage,
  });
} else if (opened.obligation) {
  // Exact, batch-settlement, and context-less upto keep the per-call path.
  const settled = await gate.settle({
    taskId: ctx.taskId!,
    obligation: opened.obligation,
    usage,
  });
  yield renderSettlement(settled);
  return;
}

if (sessionOutcome?.settlement?.kind === 'settled') {
  yield renderSettlement(sessionOutcome.settlement.outcome);
}
```

Use `reserveOpen` / `commitOpen` around the first turn's real resource work. The reservation performs the atomic context claim before work, so concurrent verified opening payments receive `unavailable` and are lapsed before they can spend upstream resources. Its reason distinguishes `active`, `settling`, `closed-unreconciled`, and `deadline`; a retained failed settlement requires operator reconciliation instead of an ordinary payer retry. A same-task retry returns `duplicate` with `pending` or `completed`; reuse durable host output instead of running it again. A mismatched task passed to `commitOpen` throws because it is a host logic error, not an expected race.

A reserved opener arms no idle or deadline timer until `commitOpen` records trusted usage. This prevents an automatic trigger from charging an unreported-usage floor or ceiling before work completes. If resource work throws after a successful reservation, the host **must** call `cancelOpen({ contextId, taskId })`; it atomically closes and lapses the reservation only while that opening task still owns it. Omitting the cancellation leaves an unresolved authorization for recovery. A reservation whose guarded authorization deadline has already passed returns `unavailable` without creating a session.

`recordTurn({ contextId, usage })` remains available when usage is already complete and there is no asynchronous work gap. Use the `beginTurn` / `finishTurn` pair around later resource work. A start result distinguishes `inactive`, a new `started` lease, and duplicate `pending` or `completed` turn ids; duplicate turns must reuse the host's durable result and never execute again. `cancelTurn` releases a later-turn lease that produced no billable work. Once a close is requested, new leases are refused; the last finishing or canceled lease performs the single settlement. An opening reservation is not reported by `active()` and does not admit later turn leases until `commitOpen` records its first trusted usage.

`usage` is required by `open()`, `commitOpen()`, `recordTurn()`, and `finishTurn()`. When trusted usage is unavailable, pass `{ kind: 'unreported' }` explicitly so the frozen offer's unreported-usage policy is applied intentionally.

The manager aggregates detailed readings with detailed readings and total readings with total readings. It may combine the two only when the frozen pricing uses `totalPerThousand`; a detailed rate cannot safely price a total-only turn, so the session records `usageIncomplete: true`. Trusted readings already accumulated remain in `usage` as a durable lower bound. `ceiling` still settles the cap, `refuse` still refuses to select a charge, and `floor` settles the greater of the configured floor and the charge supported by the retained readings. A trusted all-zero session lapses through `gate.lapse()` only when usage is complete.

`open()` remains a convenience for hosts that already have trusted first-turn usage and accept doing work before claiming the context. It writes the usage and turn count in the same atomic `create` operation as the held authorization. It is not implemented as two durable operations, so existing callers keep that atomic-write guarantee. Hosts with an asynchronous work gap should use `reserveOpen` / `commitOpen` instead.

The signed Permit2 cap is intersected with the frozen offer ceiling. Reaching that budget settles inline. After the opening usage is committed, idle and configured maximum-duration timers are process-local optimizations. `settleBy` is the earlier of the configured maximum duration and the signed deadline minus `deadlineGuardSeconds`; settlement starts at that guarded instant, never at the on-chain deadline itself. If a later turn is still in flight, the manager stops admitting work, marks usage incomplete, and settles immediately under the frozen unreported-usage policy. This may omit the unfinished turn's reading, but preserves the configured transaction-submission margin for the accumulated session charge. An uncommitted opener instead remains unresolved without an automatic timer until the host commits or cancels it from durable work evidence.

#### Durability and recovery

`InMemoryUptoSessionStore` is single-process only, caps itself at 10,000 records, and retains successful/lapsed records for one hour. Failed settlement records do not expire automatically because they are reconciliation evidence.

Production session mode must inject a shared `UptoSessionStore`. Its `create`, revision-based `compareAndSet`, and revision-based `delete` operations must be atomic across replicas. `compareAndSet` must reject records whose `contextId` differs from the lookup key. `create` may replace successful or lapsed closed records, but it must retain failed settlement evidence until an operator deletes the exact revision. The store must persist the complete held `UptoSessionRecord`, including a reserved opener with `turns: 0` and its task id in `pendingTurnIds`, the signed obligation, retained usage, `usageIncomplete`, and later pending turn ids. It must return every active or settling record from `listRecoverable()`. Protect that payload as payment authorization data. The x402 lifecycle store, merchant offer store, session store, task state, and any host conversation mapping form one recovery domain even when implemented as separate tables or keys.

Call `recover()` on startup (and from a periodic reaper in timerless/serverless deployments). It re-arms future active sessions and closes overdue active sessions through the same CAS transition. Multiple replicas may call it: only the winner of `active -> settling` invokes settlement.

An active record with in-flight work is returned in `recovery.unresolved`, including its `pendingTurnIds`. The manager deliberately arms no timer for it. A record with `turns: 0` whose pending id equals `taskId` is an uncommitted opener: restore it with `commitOpen`, or call `cancelOpen` only when durable task state proves that no billable work was delivered. Restore later turns with `finishTurn`, or use `cancelTurn` under the same proof requirement. Ignoring this queue can let the authorization expire without a settlement attempt. A record found in `settling` is also unresolved and is **never settled automatically again**: the payment may have escaped before the process stopped. If the facilitator returned an outcome but the terminal store write lost its CAS race, the manager best-effort attaches that settlement evidence to the still-settling record without claiming that it is closed. Reconcile it against the facilitator, then conditionally remove or repair the exact revision in the store.

`reserveOpen` removes the need for a host-only first-turn mutex. Two verified first turns may race the atomic `create`, but only the winner receives `reserved`; every different-task loser receives `unavailable` and has its unused authorization lapsed before resource work. The existing `open()` convenience still runs after usage is known, so callers that choose it must serialize first paid turns themselves.

Failed settlement closes the session but retains the gate's x402 evidence and blocks a replacement authorization for that context. After manual reconciliation, `forgetClosed(contextId)` conditionally removes that exact closed revision. Never call it merely to make a retry pass.

The offer and x402 lifecycle TTL must extend beyond `maxDurationSeconds` plus operational delay. Otherwise the held classification can outlive the records required by `MerchantGate.settle()`.

A standard durable store implementation remains separate follow-up work. Custom multi-replica lifecycle, offer, and session stores must satisfy the atomicity requirements above.

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

`exact` and `upto` both settle on-chain once per call. The x402 V2 [`batch-settlement` scheme](https://github.com/x402-foundation/x402/blob/main/specs/schemes/batch-settlement/scheme_batch_settlement.md) removes that from the per-call path: the payer opens and funds an on-chain **channel** once, then each subsequent call costs only an off-chain **cumulative voucher**. The merchant records vouchers as they arrive and redeems many of them in a single transaction, out of band.

That matters when settlement latency sits in the response critical path, and when per-call gas is large relative to per-call value — metering a 1000-token prompt at ~$3/MTok prices the call at ~$0.003, which is not worth an individual on-chain transfer.

#### Merchant side: configure the resource-server lifecycle

`MerchantGate` does not reproduce batch channel accounting. Cap enforcement, cumulative-amount compare-and-set, request reservation, cancellation, commit, and settlement-response enrichment remain in `@x402/evm`'s server scheme and its `ChannelStorage`. The gate drives that lifecycle through `X402Context({ resourceServer })`. Raw `{ verify, settle }` facilitator injection is insufficient for batch because it drops those resource-server hooks.

```ts
import { x402ResourceServer, HTTPFacilitatorClient } from '@x402/core/server';
import { BatchSettlementEvmScheme } from '@x402/evm/batch-settlement/server';
import { RedisChannelStorage } from '@x402/evm/batch-settlement/server/redis-storage';
import { MerchantGate, X402Context } from '@a2x/sdk/x402';

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
  resourceServer,
});

const gate = new MerchantGate({
  x402,
  exactTiming: 'after-work',
  pricing: async () => ({
    accepts: [{
      scheme: 'batch-settlement',
      network: 'eip155:84532',
      maxAmount: '3000',
      minAmount: '10',
      rates: { totalPerThousand: '100' },
      unreportedUsage: 'refuse',
      asset: USDC_BASE_SEPOLIA,
      payTo: MERCHANT,
      resource: 'https://api.example.com/chat',
      description: 'Metered access, settled in batches',
    }],
  }),
});
```

The resource server enriches the published requirement with server-owned fields such as `receiverAuthorizer` and `withdrawDelay`; do not duplicate them in the pricing callback. It must be initialized, and every network/scheme in an offer must be registered. `MerchantGate` rejects a batch offer before publication if the matching resource-server scheme is absent.

On a charge, `open()` verifies and reserves the channel, then returns a `batch-settlement` obligation. `settle()` meters usage, passes the actual amount as the official settlement override, and commits the reservation. If work throws, call `gate.abort()` as shown in the shared gate example; it dispatches `onVerifiedPaymentCanceled` and releases the task claim so the same voucher can retry. A cooperative refund returns `kind: 'handled'`, settles immediately, and never permits resource work to run.

The completed x402 store entry is retained until its configured TTL for batch operations. Its receipt contains `extra.channelState`, allowing recovery if the process stops after commit but before the terminal A2A result is durably recorded.

Redemption is still a separate background concern and should normally be a singleton across horizontally scaled deployments, on whatever cadence suits your economics:

```ts
const manager = scheme.createChannelManager(facilitatorClient, 'eip155:84532');
setInterval(() => manager.claimAndSettle(), 60 * 60 * 1000);   // one singleton, not per-replica
setInterval(() => manager.refundIdleChannels({ idleSecs: 7 * 24 * 60 * 60 }), 24 * 60 * 60 * 1000);
```

When using the lower-level `requestPayment()` API without a resource server, the caller remains responsible for every scheme-specific `extra` field. That path can advertise a batch requirement but cannot provide the reservation/cancellation lifecycle required for safe resource work; use `resourceServer` with `MerchantGate` for the complete merchant flow.

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

Persist `signed.batch` alongside the payload if reconciliation may happen in a later process: neither the snapshot nor the `attemptId` can be reconstructed afterwards, and a resumed reconcile must reuse the persisted `attemptId` — minting a new one severs the attempt from its own storage writes and quarantine marker. The binding is JSON-safe by construction — a fresh channel's `preAttemptState` is `null`, never an `undefined` that `JSON.stringify` would silently drop (an absent key is rejected at reconcile time, so a lossy round trip would otherwise break the repair for exactly the opening-deposit case). A caller resuming from a persisted *payload* alone can rebuild the payload-provable half with `getX402BatchSettlementBinding(payload)`, but must combine it with the snapshot and attempt id it captured at signing time to form the `bindings` entry.

Skip reconciliation and the payer's cumulative amount never advances: every subsequent call re-signs an identical voucher against a channel it still believes is unfunded — and therefore signs a **fresh deposit** each time. Receipts from other schemes, malformed ones (including non-object array entries), any naming a channel outside `bindings`, and any whose cumulative the binding cannot vouch for are ignored. A cumulative is vouched for when it stays at or below the signed ceiling **and** either equals `preAttemptState cumulative + extra.chargedAmount` (a metered settlement — see the ceiling bullet above) or, absent a usable `chargedAmount`, equals the ceiling exactly (the unmetered lifecycle). Ignored receipts do not throw — they simply leave `applied` empty, which is why an empty `applied` after a settled payment must be treated as a failure (below). `AggregateError` is reserved for storage operations that throw, raised after the other receipts have been tried so one failing write cannot drop a good receipt.

When `bindings` is an array, every entry must name a distinct channel. Reconcile successive attempts on the same channel separately; collapsing them into one call would lose which deposit floor belongs to which cumulative voucher. Reconciliation calls through the same storage object are serialized per channel inside the process, so a delayed older receipt cannot overwrite a newer cumulative.

The write itself is a **deterministic fold**: `trusted snapshot + binding + receipt → next state`, computed without reading the record being replaced. That makes retries exact rather than best-effort — re-running the same binding and receipt rewrites the same state, so a torn write (cumulative committed without the balance, or the reverse) is repaired by simply reconciling again, for deposits and voucher-only payments alike.

Attempts are ordered by **identity, not by the cumulative**: a metered call may charge zero, so two attempts can share a cumulative while the newer one moved real funds. Every binding carries an `attemptId` (minted by `signX402Payment` — reuse the persisted one when resuming), and every successful fold stamps it onto the record as `lastAppliedAttemptId`. A fold rewrites a record it already stamped (the idempotent retry), and refuses one that no longer descends from its own snapshot — so a replayed older receipt cannot roll back a newer attempt's balance even at an equal cumulative. A successful fold clears a quarantine marker only when that marker is **owned by the same attempt** (or names no owner); a marker some other attempt wrote survives, because the merchant may still hold that attempt's spendable voucher.

That receipt lock alone cannot make concurrent signing safe: `@x402/evm` only reads storage while it creates a payload and does not reserve the next cumulative or deposit. Two overlapping attempts can therefore read the same empty state and each authorize a fresh deposit before either receipt exists. `A2XClient` prevents this in-process by holding one lease per storage object across the complete sign → submit → reconcile/quarantine lifetime (conservatively serializing different channels that share that object because the channel id is not available until after signing). If the lease holder is quarantined, attempts already queued behind it are rejected with the same `X402ReconciliationError` before they can sign from stale storage; repair or retire the channel before retrying. The low-level helpers cannot retain a lock across your network call, so manual flows must serialize that entire lifetime per channel themselves. The storage interface has no cross-process compare-and-set operation; when multiple processes or replicas share a backend, route each channel through one owner or add an application-level durable reservation before signing.

**An empty `applied` after a settled payment is a failure, not a no-op.** The voucher is spent either way, so "nothing to record" and "the merchant withheld or falsified the receipt" have identical consequences: local state did not move, and the next call re-signs or re-deposits. `A2XClient` raises `X402ReconciliationError` with `reason: 'no-matching-receipt'` in that case; a caller driving the helper directly should treat it the same way.

The SDK also fails closed when the merchant returns any terminal A2A task (`completed`, `failed`, `canceled`, or `rejected`) but omits a usable receipt. Settlement can succeed before agent execution later fails, and once the payer handed over a voucher the merchant may retain and redeem it; neither a remote status marker nor the task's final state can prove that local channel state is safe to reuse.

The binding becomes outstanding as soon as the signed submission is handed to the transport. If blocking transport/JSON parsing fails, a non-blocking unary call returns an intermediate task, a follow-up SSE stream errors or is aborted, the caller closes that stream early, or the stream reaches EOF before a receipt or a complete retry prompt, `A2XClient` raises the same quarantine error with `reason: 'ambiguous-response'`. A status marker alone is not a retry prompt: `x402.payment.required` must also be present before the client treats the previous voucher as rejected. A known intermediate unary response is available as `task`; transport failures and streaming exits have no complete task, and the original transport/stream failure is available as `cause` when one occurred. In every case the merchant must be assumed to hold the voucher until an operator reconciles or retires the channel.

A matching success receipt takes precedence over a contradictory retry prompt anywhere later in the same response stream, whether it appears in the same event or a separate event. Once that receipt advances durable channel state, `A2XClient` does not sign again for the call; doing so would authorize the same work twice. This batch-only guard does not change `exact` or `upto` retry behavior.

#### A missed receipt does not self-heal

The merchant requires the next voucher's cumulative to equal exactly `charged + amount`, and `@x402/evm`'s corrective-recovery path needs a signer with `readContract`, which a viem `LocalAccount` does not have. A payer that loses a receipt stays desynced until its storage is repaired out of band, and the next call can sign a fresh on-chain deposit.

Because that is a funds-bearing failure, `A2XClient` **throws** `X402ReconciliationError` rather than continuing quietly — an operator who is never told cannot quarantine the channel first. It carries `channelId`, the merchant's terminal `task` when available, and a `reason`: `write-failed` (your storage threw — usually transient), `no-matching-receipt` (a terminal task arrived but nothing was recorded), or `ambiguous-response` (the response ended before either safe outcome was known). It also carries everything the repair needs: `binding` — the attempt's complete `X402BatchSettlementBinding`, including the pre-attempt snapshot that cannot be reconstructed afterwards — and `taskId`, the paid task's id, which on a transport or stream failure is the only handle for fetching the settled receipt (the client consumed the `payment-required` task internally, so you never saw the id). When present, `task` means catching the error still leaves you the result the merchant produced — including on the streaming path, where reconciliation runs before the terminal event is yielded and a throw means you never see that event:

```ts
try {
  const task = await client.sendMessage({ message });
} catch (err) {
  if (err instanceof X402ReconciliationError) {
    // Repair: fetch the receipt the response lost, then re-run the fold
    // with the attempt's own binding. A successful fold restores the exact
    // post-attempt state and clears the quarantine marker.
    const final = (err.task as Task | undefined) ??
      (err.taskId ? await client.getTask(err.taskId) : undefined);
    if (final && err.binding) {
      const { applied } = await reconcileX402BatchSettlement(
        getX402Receipts(final),
        { storage, bindings: err.binding },
      );
      // Check `applied`: ignored receipts do not throw, so an empty result
      // means the fetched task still lacks a usable receipt and the channel
      // is still quarantined — returning here would report a repair that
      // never happened.
      if (applied.length > 0) return final;
    }
    // Nothing to repair from yet — leave the channel quarantined.
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

#### A submitted attempt survives a crash

Quarantine only helps when some exit path lives long enough to write it. One does not: hand the signed payload to `fetch`, then lose the process before any response, catch, or `finally` runs. The in-process lease, the attempt object, and its binding all die with the process, and a restarted payer would read the unchanged pre-attempt record — and sign a second real deposit while the merchant may hold the first.

`A2XClient` therefore **persists the attempt before the transport boundary**: immediately before the request body is handed to `fetch`, it awaits a durable write of `pendingAttempt` — `{ attemptId, binding, taskId, submittedAt }` — onto the channel record (a failed write aborts the request before anything is sent, which moves no funds). While that record exists, signing against the channel throws `X402AttemptPendingError`, whatever process is asking. The record clears when the owning attempt's receipt folds, a valid retry prompt proves its rejection, or its quarantine marker supersedes it.

After a crash, recovery is the same shape as quarantine repair: read `pendingAttempt` off the stored record, fetch the task via `getTask(pendingAttempt.taskId)`, and run `reconcileX402BatchSettlement` with `pendingAttempt.binding`. A folded receipt clears the record and payments resume; if the task shows the payload never reached the merchant (the crash landed between the write and `fetch`), remove `pendingAttempt` manually — a conservatively blocked unsent voucher is safe, just operator-visible.

#### Deletion erases the generation

Replay protection lives in the stored record (`lastAppliedAttemptId`), so a **deleted** record is indistinguishable from a channel that never opened — a stale receipt from before the deletion can resurrect it, balance and all. a2x never deletes channel records, but `@x402/evm`'s cooperative refund path does when a channel drains. If you share this storage with that flow, do not let it perform an unversioned delete.

The supported retirement is **salt rotation**: change `batchSettlement.salt` so future payments derive a fresh channel id, and never reuse the old channel. Retaining an arbitrary record instead does **not** preserve a new generation — keeping the old `lastAppliedAttemptId` leaves the old receipt as the record's owner, so replaying that receipt rewrites the record, pre-refund balance included; and keeping a positive balance makes the signer treat the refunded channel as still funded. A manually retained record is safe only when it simultaneously carries a generation no payment attempt owns **and** refuses signing. With the current primitives that means replacing the record with exactly:

```ts
await storage.set(channelId.toLowerCase(), {
  lastAppliedAttemptId: `retired:${crypto.randomUUID()}`, // owned by no attempt → every replay fails provenance
  quarantinedAt: new Date().toISOString(),                // signing refuses while present
  quarantineReason: 'retired',
});
```

A first-class retirement/tombstone operation is planned alongside the transactional storage extension.

#### Quarantine survives a restart

The in-process rejection above dies with the process — and so does the error object carrying the repair inputs. To stop a restarted payer from signing a fresh deposit out of the same desynced storage, the SDK also **persists** the quarantine: alongside raising `X402ReconciliationError` it best-effort writes `quarantinedAt` / `quarantineReason` onto the channel's stored record, together with the recovery record — `quarantineBinding` (the attempt's complete binding) and `quarantineTaskId` (the paid task's id). While that marker is present, signing against the channel throws `X402ChannelQuarantinedError` — before the payload ever reaches the merchant.

Two ways to lift it:

- **Repair**: re-run `reconcileX402BatchSettlement` with the attempt's binding and the receipt — after a restart, read `quarantineBinding` off the stored record and fetch the receipt via `getTask(quarantineTaskId)`. A successful fold rewrites the exact post-attempt state and clears the marker. Only the owning attempt's fold clears it: the marker carries the attempt's id in its binding, and a different attempt reconciling the same channel leaves the block in place.
- **Manual**: after verifying the stored state out of band, remove the `quarantine*` keys yourself.

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

If the merchant's terminal task records a payment failure (the latest receipt is unsuccessful), the call throws `X402PaymentFailedError` with the on-chain reason. The option surface is as follows:

| Field | Default | Purpose |
|---|---|---|
| `signer` | required | viem `LocalAccount` used to produce the EIP-3009 authorization. |
| `maxAmount` | no cap | Atomic-unit ceiling. Filters `accepts[]` before the selector runs. |
| `selectRequirement` | first EVM `scheme === 'exact'` | Predicate over the (already filtered) requirements. Return `undefined` to abort. |
| `allowUpto` | `false` | Let the default selector fall back to an EVM `upto` offer when no `exact` one fits. See [Paying an `upto` offer](#paying-an-upto-offer). |
| `upto` | none | RPC configuration for the `upto` payer — `{ rpcUrl }`, or keyed by numeric chain id. Needed only when the merchant offers [gas-sponsored Permit2 approval](#gas-sponsored-permit2-approval). |
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

#### Gas-sponsored Permit2 approval

An `upto` payment settles through Permit2, which requires the payer to have approved Permit2 on the token — an on-chain transaction the payer's wallet may never have made (and, for a fresh wallet with no gas token, *cannot* make). Merchants bridge that gap by advertising the gas-sponsoring facilitator extensions on the V2 envelope: `eip2612GasSponsoring` (the payer signs an EIP-2612 permit; the facilitator submits it and pays the gas) and `erc20ApprovalGasSponsoring` (the payer signs a raw approval transaction for the facilitator to fund and broadcast).

Producing either payload requires reading the chain — the signer's current Permit2 allowance, and for EIP-2612 the permit nonce. A plain `LocalAccount` cannot do that, so the payer needs an RPC endpoint:

```ts
const client = new A2XClient(url, {
  x402: {
    signer,
    maxAmount: 1_000_000n,
    allowUpto: true,
    // One endpoint for everything, or keyed by chain id:
    // upto: { 84532: { rpcUrl: 'https://sepolia.base.org' } }
    upto: { rpcUrl: 'https://sepolia.base.org' },
  },
});
```

The endpoint is used **only for reads** — signing never leaves the process, and nothing is broadcast through it. Without it the extension payloads are silently skipped (there is nothing to skip when the merchant advertises no gas sponsoring), and a merchant that requires an allowance the payer doesn't have rejects the payment with `permit2_allowance_required`. The SDK never defaults the endpoint: choosing which RPC provider to trust is the caller's decision.

The same option exists on `signX402Payment` for manually driven flows:

```ts
const signed = await signX402Payment(task, {
  signer,
  allowUpto: true,
  upto: { rpcUrl: 'https://sepolia.base.org' },
});
```

The `a2x` CLI exposes both halves of this as `a2x a2a send <url> <message> --allow-upto --rpc-url <url>` (with `A2X_RPC_URL` or a `rpcUrl` entry in `~/.a2x/config.json` as fallbacks for the endpoint).

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
- **`exact`, `upto`, and `batch-settlement` schemes, EVM networks** (`base`, `base-sepolia`, `polygon`, `avalanche`, …). `upto` and `batch-settlement` are V2-only and require `@x402/evm` ≥ 2.20 (the declared peer floor); the client auto-selects neither (see [Paying an `upto` offer](#paying-an-upto-offer) and [Batch settlement](#batch-settlement-prepaid-channels)). `UptoSessionManager` optionally meters one `upto` authorization across a conversation. For `batch-settlement` the SDK covers the **payer** end-to-end; the merchant configures an `x402ResourceServer` through `X402Context.resourceServer`, and redemption stays out of the SDK. Other schemes pass through the pipeline untouched — override `BaseX402Context.validatePayloadShape` to validate them. Adding Solana support means passing a Solana-compatible signer in a later release.

## Reference

- V2 transport (in-repo, vendored from the x402 Foundation): [`specification/x402-transport-a2a-v2.md`](https://github.com/planetarium/a2x/blob/main/specification/x402-transport-a2a-v2.md)
- V1 lineage: [`specification/x402-transport-a2a-v1.md`](https://github.com/planetarium/a2x/blob/main/specification/x402-transport-a2a-v1.md), [`specification/a2a-x402-v0.2.md`](https://github.com/planetarium/a2x/blob/main/specification/a2a-x402-v0.2.md), [`specification/x402-v1.md`](https://github.com/planetarium/a2x/blob/main/specification/x402-v1.md)
- Migration (SDK API, not protocol): [Migrating off `x402PaymentHook`](./migration-x402-v2.md)
