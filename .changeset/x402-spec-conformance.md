---
"@a2x/sdk": minor
---

Align `@a2x/sdk/x402` with a2a-x402 v0.2 spec, and fold x402 handling into `A2XClient` natively.

Closes #92. Two-part change:

1. Six spec-conformance fixes (one MUST violation, five drift gaps).
2. `X402Client` is removed — `A2XClient` itself runs the Standalone Flow when given an `x402` option, so callers no longer have to know up front whether the target agent gates on x402.

**Breaking — client surface.** The `X402Client` wrapper class is gone. Migrate by passing the same options to `A2XClient` instead:

```ts
// Before
import { X402Client } from '@a2x/sdk/x402';
const x402 = new X402Client(new A2XClient(url), { signer });
await x402.sendMessage({ message });

// After
import { A2XClient } from '@a2x/sdk/client';
const client = new A2XClient(url, { x402: { signer } });
await client.sendMessage({ message });
```

`A2XClient.sendMessage` and `A2XClient.sendMessageStream` now both transparently detect `payment-required`, sign one of the merchant's `accepts[]` requirements, and resubmit on the same task — the caller observes the final settled task (blocking) or a single merged event stream (streaming) with no manual orchestration. The streaming case in particular: the dance happens in-band, so consumers see `payment-required → payment-verified → working → artifacts → payment-completed` on one generator.

The new `A2XClientX402Options` carries `signer`, optional `maxAmount` (atomic-unit ceiling enforced before the selector runs), `selectRequirement`, and `onPaymentRequired`. Setting `x402` automatically registers `X402_EXTENSION_URI` on the client's `extensions` set so the §8 header is emitted on every request.

The low-level primitives (`signX402Payment`, `getX402PaymentRequirements`, `getX402Receipts`, `getX402Status`) remain exported for callers that need to drive the dance manually — e.g. inspect the `payment-required` task before signing.

**Breaking — `X402_ERROR_CODES` renames.** Spec §9.1 defines the canonical code names. Two renames bring the SDK back in line:

- `SETTLE_FAILED` → `SETTLEMENT_FAILED`
- `AMOUNT_EXCEEDED` → `INVALID_AMOUNT`

Also removed the unused `NO_REQUIREMENTS` code (never emitted). Consumers reading `x402.payment.error` string values or pattern-matching on these constants must update.

**New — spec §9.1 error codes.** Verify failures now dispatch through `mapVerifyFailureToCode()`, which inspects the facilitator's `invalidReason` and returns one of `INSUFFICIENT_FUNDS`, `INVALID_SIGNATURE`, `EXPIRED_PAYMENT`, `DUPLICATE_NONCE`, or `VERIFY_FAILED` (fallback) instead of always emitting the generic `VERIFY_FAILED`.

**New — `X-A2A-Extensions` activation header (§8 MUST).** `A2XClient` emits the header when extensions are registered:

- new `A2XClientOptions.extensions?: string[]` option
- new `A2XClient.registerExtension(uri)` method (idempotent)
- new `A2XClient.activatedExtensions` read-only getter
- setting `A2XClientOptions.x402` auto-registers `X402_EXTENSION_URI` so the header is emitted with no extra wiring

Server-side, `DefaultRequestHandler` rejects requests whose header doesn't list every `required: true` extension on the AgentCard (error code `-32600`). Enforcement only runs when a `RequestContext` is supplied, so pure in-process handler invocations are unaffected.

**New — `payment-verified` transient state (§7.1).** Streaming clients now observe a `working` + `x402.payment.status: payment-verified` event between `payment-submitted` and `payment-completed`, matching the spec's 3-step lifecycle.

**Fix — `x402.payment.receipts` preserves history (§7).** Prior receipts are merged rather than overwritten across retries, honoring spec §7's "complete history" requirement.

**New — `payment-rejected` handling (§5.4.2 / §7.1).** The executor now recognizes a client-sent `x402.payment.status: payment-rejected` and terminates the task (`failed` + status `payment-rejected`) instead of looping on `payment-required`.

**New — `retryOnFailure` executor option.** Opt in to spec §9's retry branch: verify/settle failures re-publish `payment-required` on the same task with the failure reason carried in `X402PaymentRequiredResponse.error`, letting the client fix the issue and resubmit. Default behavior (terminate with `failed`) is unchanged.
