# Merchant x402 payments

Read this page when an a2x agent charges callers or publishes output before payment settlement. The canonical API and protocol reference remains the SDK's [x402 payments guide](../../../packages/a2x/docs/guides/advanced/x402-payments.md#shared-merchant-policy-gate); confirm current signatures in the installed `@a2x/sdk/x402` declarations before writing code.

## Choose the merchant policy first

Do not let event ordering accidentally choose the payment economics. A `MerchantGate` host must decide:

| Decision | Choices | Effect |
|---|---|---|
| Exact settlement | `before-work` or `after-work` | Whether an `exact` payment settles before resource work or after it. This setting does not change `upto` or `batch-settlement`. |
| Content delivery | `after-settlement` or `after-verification` | Whether output stays buffered until final payment or may be published provisionally. |
| Missing metered usage | `ceiling`, `floor`, or `refuse` | What each `upto` or `batch-settlement` price does when trusted usage is unavailable. |
| Free versus paid | `pricing` returns `null` or a frozen `MerchantOffer` | Which requests enter the payment round trip and which terms the payer signs. |

For `exact`, use the combination that matches the requested risk allocation:

| Exact timing | Delivery timing | Behavior |
|---|---|---|
| `before-work` | Either value | Payment is already settled before work, so delivery is final rather than provisional. The payer bears failed-work risk. |
| `after-work` | `after-settlement` | Buffer, settle, then publish. Prefer this for ordinary unary work when the merchant accepts failed-settlement risk. |
| `after-work` | `after-verification` | Publish provisional chunks, then settle completed or partially failed work. Use this only when lower latency justifies delivered-but-unsettled risk. |

`UptoSessionManager` requires `deliveryTiming: 'after-verification'`; it rejects `after-settlement` because a conversation-spanning authorization remains unsettled across turns.

For unpriceable metered work, `ceiling` charges the authorized maximum, `floor` charges `minAmount` (or zero), and `refuse` makes no settlement request. Do not substitute a zero token reading for missing usage: trusted zero is billable as zero, while unavailable accounting is `{ kind: 'unreported' }`.

## Construct the gate explicitly

```ts
import { MerchantGate, X402Context } from '@a2x/sdk/x402';

const x402 = new X402Context({
  x402Version: 2,
  facilitator,
  store: lifecycleStore,
});

const gate = new MerchantGate({
  x402,
  pricing: resolveMerchantOffer,
  exactTiming: 'after-work',
  deliveryTiming: 'after-verification',
  offerStore,
  deliveryMetadata: ({ provisional }) => ({
    'merchant.example/delivery': provisional ? 'provisional' : 'final',
  }),
  onError: (error, context) => logger.error({ error, ...context }),
});
```

Required inputs are `x402`, `pricing`, `exactTiming`, and `deliveryTiming`. `offerStore`, `deliveryMetadata`, and `onError` are optional, but production deployments normally need durable stores and observability.

`deliveryMetadata` is application-owned. Neither A2A nor x402 defines a standard provisional-delivery key, so declare a versioned application extension when clients need to interpret it.

## Preserve the execution boundary

Handle `open()` outcomes before resource work:

- Render `request-payment` and stop the turn.
- Render `refuse` as a payment failure and stop.
- Treat `handled` as terminal; a scheme-specific operation such as a refund has already completed.
- Run work only for `proceed`. A missing obligation means the request is free.

Before emitting paid content, call `authorizeDelivery()` and publish only an `authorized` result. With `after-settlement`, settle buffered work first. With `after-verification`, authorize before the first chunk and retain the returned metadata for provisional events.

After work:

- Call `settle()` once with trusted usage.
- If work fails before publication, call `abort()` so the gate can lapse or cancel without charging after-work execution.
- If work fails after publication, pass partial usage to `abort()`; the gate attempts settlement because delivered content cannot be revoked.
- Do not let an HTTP or SSE disconnect cancel the paid execution after the payment submission boundary. The worker owns completion, settlement, and terminal task persistence; the connection owns only the subscription.

Treat a successful delivery authorization as irreversible even when no transport acknowledgement arrives. If settlement fails afterwards, retain the task and claim for operator reconciliation rather than replaying work automatically.

## Use durable atomic stores in production

The in-memory defaults are for one process and disposable state. A restart-safe or multi-replica host needs:

- a lifecycle `BaseX402Store` implementation whose `updateIfStatus()` is an atomic compare-and-set;
- an atomic `updateMerchantDeliveryIfStatus()` that checks lifecycle status and merges nested delivery fields in one backend transaction;
- a durable `MerchantOfferStore` with atomic publishing, claim, release, and claim-status operations;
- for sessions, a durable `UptoSessionStore` with atomic `create`, revision CAS, conditional delete, and recovery listing.

The offer, lifecycle, task, output, and session records form one recovery domain. TTLs must outlive the longest work or session duration plus operational recovery delay. Never release a claim merely because the transport failed; settlement or resource side effects may already have escaped.

For `batch-settlement`, configure the official x402 resource server and durable channel storage. Raw facilitator injection does not provide reservation, cancellation, commit, refund, or channel-recovery hooks.

## Verify paid behavior

In addition to the ordinary agent checks, test:

1. Failure before output does not charge an after-work obligation.
2. Failure after provisional output settles exact or partial metered usage.
3. Settlement failure after publication retains reconciliation evidence and blocks automatic replay.
4. Client disconnect does not stop merchant work or settlement.
5. Concurrent delivery authorization and settlement cannot authorize a failed payment or erase audit fields.
6. Restart recovery preserves claims, held obligations, usage, output, and terminal receipts.
