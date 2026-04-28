---
'@a2x/sdk': minor
---

Make `resource` and `description` required on `X402Accept`. The x402 executor
used to fabricate two `PaymentRequirements` MUST-fields when the merchant
omitted them — defaults that violated the spec.

Closes [#123](https://github.com/planetarium/a2x/issues/123).

**Why.** Per x402 v1 §`PaymentRequirements`:

- `resource` MUST be a URL identifying what is being paid for. The SDK
  defaulted it to the literal string `'a2a-x402/access'` (not a URL). Strict
  facilitators reject this.
- `description` MUST describe the purchase. The SDK defaulted it to `''`,
  which surfaces in wallet UIs as the consent prompt — users were being asked
  to sign for a payment whose purpose is "(empty)".

**Breaking — type tightening.**

- `X402Accept.resource: string` (was `string | undefined`).
- `X402Accept.description: string` (was `string | undefined`).
- `X402_DEFAULT_RESOURCE` export is removed.
- `description ?? ''` fallback inside `normalizeAccept` is removed.

The TypeScript compiler now forces merchants to supply spec-conformant values.
Existing code that relied on the defaults must pass real values:

```ts
// Before — silently shipped non-URL resource and empty description
agent.addExtension({ uri: X402_EXTENSION_URI }, {
  accepts: [{ scheme: 'exact', network: 'base', maxAmountRequired: '...' }],
});

// After — required fields enforced at compile time
agent.addExtension({ uri: X402_EXTENSION_URI }, {
  accepts: [{
    scheme: 'exact',
    network: 'base',
    maxAmountRequired: '...',
    resource: 'https://api.example.com/premium',
    description: 'Premium agent access',
  }],
});
```

Samples, docs, and test fixtures are updated to pass real values.
