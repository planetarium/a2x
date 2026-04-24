---
"@a2x/sdk": minor
---

Align `@a2x/sdk/x402` with a2a-x402 v0.2 spec.

Closes #92. Audit of PR #72 turned up one MUST violation (§8 activation header) and five spec-drift gaps. This release fixes all of them together so the SDK interoperates with spec-strict x402 clients and servers.

**Breaking — `X402_ERROR_CODES` renames.** Spec §9.1 defines the canonical code names. Two renames bring the SDK back in line:

- `SETTLE_FAILED` → `SETTLEMENT_FAILED`
- `AMOUNT_EXCEEDED` → `INVALID_AMOUNT`

Also removed the unused `NO_REQUIREMENTS` code (never emitted). Consumers reading `x402.payment.error` string values or pattern-matching on these constants must update.

**New — spec §9.1 error codes.** Verify failures now dispatch through `mapVerifyFailureToCode()`, which inspects the facilitator's `invalidReason` and returns one of `INSUFFICIENT_FUNDS`, `INVALID_SIGNATURE`, `EXPIRED_PAYMENT`, `DUPLICATE_NONCE`, or `VERIFY_FAILED` (fallback) instead of always emitting the generic `VERIFY_FAILED`.

**New — `X-A2A-Extensions` activation header (§8 MUST).** `A2XClient` emits the header when extensions are registered:

- new `A2XClientOptions.extensions?: string[]` option
- new `A2XClient.registerExtension(uri)` method (idempotent)
- new `A2XClient.activatedExtensions` read-only getter
- `X402Client` auto-registers `X402_EXTENSION_URI` on its wrapped `A2XClient` so existing call sites get the header for free

Server-side, `DefaultRequestHandler` rejects requests whose header doesn't list every `required: true` extension on the AgentCard (error code `-32600`). Enforcement only runs when a `RequestContext` is supplied, so pure in-process handler invocations are unaffected.

**New — `payment-verified` transient state (§7.1).** Streaming clients now observe a `working` + `x402.payment.status: payment-verified` event between `payment-submitted` and `payment-completed`, matching the spec's 3-step lifecycle.

**Fix — `x402.payment.receipts` preserves history (§7).** Prior receipts are merged rather than overwritten across retries, honoring spec §7's "complete history" requirement.

**New — `payment-rejected` handling (§5.4.2 / §7.1).** The executor now recognizes a client-sent `x402.payment.status: payment-rejected` and terminates the task (`failed` + status `payment-rejected`) instead of looping on `payment-required`.

**New — `retryOnFailure` executor option.** Opt in to spec §9's retry branch: verify/settle failures re-publish `payment-required` on the same task with the failure reason carried in `X402PaymentRequiredResponse.error`, letting the client fix the issue and resubmit. Default behavior (terminate with `failed`) is unchanged.
