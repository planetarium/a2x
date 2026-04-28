---
'@a2x/sdk': patch
---

`@a2x/sdk/client` no longer pulls `x402` into the bundle at build time
when consumers don't use it.

Closes [#134](https://github.com/planetarium/a2x/issues/134).

**Why.** `x402` is declared as an optional peer dependency, but its
runtime helpers were statically imported into the
`@a2x/sdk/client` chunk. Bundlers (Next.js, Vite, esbuild, …) treated
the import as required and either failed the build or shipped the
package even on code paths that never signed a payment.

**Fix.** `signX402Payment` now lazy-imports the `x402` runtime inside
the function body, so the static `import` graph of the client chunk
no longer references it. Consumers who never invoke an x402-gated flow
do not need to install `x402`. The static imports in
`dist/client/*.js` are gone — verifiable by grepping the published
bundle.
