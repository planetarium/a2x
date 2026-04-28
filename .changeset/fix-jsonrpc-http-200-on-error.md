---
'@a2x/sdk': patch
---

Return HTTP 200 with a JSON-RPC error body for parse failures and handler
exceptions in the bundled HTTP wrappers (`toA2x()` and the four samples). The
JSON-RPC over HTTP convention is to keep the HTTP layer at `200` and surface
the error code in the response body — clients that skip body parsing on `4xx`
never see the JSON-RPC code otherwise.

Closes [#122](https://github.com/planetarium/a2x/issues/122).

**Why.** `DefaultRequestHandler.handle()` already followed this convention for
string bodies (it returned a `JSONParseError` JSON-RPC response, not a thrown
error). The bug was confined to the HTTP wrappers above it: `toA2x()`, the
Express sample, and the three Next.js samples all returned HTTP `400` for
malformed JSON and any handler exception. A spec-conforming client that read
status code as "no body to parse" would miss the `-32700 Parse error` /
`-32603 Internal error` payload.

**Changes.**

- `transport/to-a2x.ts`: narrows the parse-error catch to `JSON.parse` only,
  adds a separate handler-exception catch that emits `-32603` with the
  request id (or `null` when params are unparseable). Both paths return HTTP
  `200`.
- `transport/to-a2x.ts`: extracts the request listener into the new exported
  `createA2xRequestListener()` so the dispatch can be unit-tested without
  going through `listen()`.
- `samples/express`, `samples/nextjs`, `samples/nextjs-skill`,
  `samples/nextjs-x402`: same treatment, mirrored for the App Router shape.

Adds `to-a2x-http.test.ts` covering the malformed-body and unknown-method
paths to lock the HTTP-200 contract in.
