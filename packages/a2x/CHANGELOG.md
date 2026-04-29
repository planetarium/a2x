# @a2x/sdk

## 0.12.0

### Minor Changes

- [#150](https://github.com/planetarium/a2x/pull/150) [`fe225a1`](https://github.com/planetarium/a2x/commit/fe225a1176105b94c3251de7f415db648dad72a7) Thanks [@ost006](https://github.com/ost006)! - `AgentEvent` now supports `file` and `data` variants alongside `text`, so
  multi-modal agents (image generation, structured output, document creation,
  …) can stay on the `BaseAgent` path without dropping to a custom
  `AgentExecutor`.

  Closes [#148](https://github.com/planetarium/a2x/issues/148).

  **Why.** A2A v0.3 already defines first-class non-text part shapes
  (`FilePart`, `DataPart`) and the SDK's internal `Part` union has matched
  that since day one. But `AgentEvent` — the contract between agent code
  and the runner/executor — only had a `text` data variant, so non-text
  output had no expression on the `BaseAgent` path: the default
  `AgentExecutor.executeStream` translated `text` into artifact text-parts
  and silently dropped everything else. The only workaround was to abandon
  `BaseAgent` and emit raw `TaskArtifactUpdateEvent`s from a custom
  `AgentExecutor`, which leaks A2A protocol details into agent code.

  **What's new.**

  - `AgentEvent` adds `{ type: 'file', file: {...} }` and
    `{ type: 'data', data, mediaType? }` variants. The `text` variant gains
    an optional `mediaType` field for distinguishing `text/markdown`,
    `application/json`, etc.
  - The default `AgentExecutor` (both `execute()` and `executeStream()`)
    maps each non-text event to a fresh artifact: `file` → `FilePart`
    artifact, `data` → `DataPart` artifact, each with a unique
    `artifactId`. Text events keep their existing accumulation behavior
    (single text artifact per task, append-mode chunks during streaming).
  - `LlmAgent.run()` no longer filters non-text parts out of the LLM
    response — they are yielded as `file` / `data` events. (The bundled
    Anthropic / OpenAI / Google provider converters today only emit text
    blocks from chat-completion responses; non-text output mostly applies
    to custom `BaseAgent` implementations.)

  **Compatibility.** Additive on the wire: clients receive standard A2A
  v0.3 `FilePart` / `DataPart` artifacts, which `A2XClient` and its
  response parser already supported. Existing text-only agents and
  clients continue to work unchanged.

  `switch (event.type) { … }` blocks over `AgentEvent` without a
  `default:` branch will need new `case 'file'` / `case 'data'` arms (or
  a `default:`) under TypeScript's strict-exhaustiveness checks.

## 0.11.1

### Patch Changes

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - `isFilePart()` now recognizes the v0.3 spec FilePart wire shape in
  addition to the SDK's flat internal shape.

  Closes [#142](https://github.com/planetarium/a2x/issues/142) (fix 4 of 5).

  **Why.** v0.3 `FilePart` (`a2a-v0.3.0.json:828`) is nested:
  `{ kind: 'file', file: { bytes | uri, mimeType?, name? } }`. The
  pre-fix guard only matched the SDK's internal flat shape (`{ raw }` /
  `{ url }`), so a spec-conformant FilePart coming off the wire fell
  through every part type guard and was silently classified as none. The
  v0.3 response mapper output already produced the nested shape
  correctly — only input classification was asymmetric.

  **Fix.** The guard now also returns `true` for
  `{ kind: 'file', file: { ... } }`. `isTextPart` and `isDataPart`
  already handled their respective shapes correctly and are unchanged.

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - Push notification webhooks now POST the spec-mapped Task wire shape, not
  the internal `Task` object.

  Closes [#142](https://github.com/planetarium/a2x/issues/142) (fix 1 of 5).

  **Why.** `DefaultRequestHandler._dispatchPushNotifications` handed the
  raw internal `Task` to `PushNotificationSender.send`, which
  `JSON.stringify`d it straight onto the wire. v1.0 receivers got
  `state: "completed"` / `role: "agent"` (lowercase) instead of
  `TASK_STATE_COMPLETED` / `ROLE_AGENT`, and v0.3 receivers got Task /
  Message / Part objects without the required `kind` discriminator. The
  body never matched what the same task served via `tasks/get` would
  have looked like.

  **Fix.** The dispatcher now runs the task through the same
  `ResponseMapper` that produces the JSON-RPC response (v0.3 `kind` /
  v1.0 UPPER_CASE) before handing the body to the sender.

  **Public surface.** `PushNotificationSender.send(config, body: unknown)`
  replaces `send(config, task: Task)` — the second parameter is now the
  already-version-mapped wire payload. Custom sender implementations
  should update their parameter type; the runtime semantics
  (`JSON.stringify(value)`) are unchanged. The default
  `FetchPushNotificationSender` is updated in place.

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - `tasks/pushNotificationConfig/set` now accepts the v1.0 flat input
  shape so clients can round-trip the response the server just gave
  them.

  Closes [#142](https://github.com/planetarium/a2x/issues/142) (fix 2 of 5).

  **Why.** `V10ResponseMapper.mapPushNotificationConfig` returns the flat
  shape defined by `a2a-v1.0.0.proto:464`
  (`{ taskId, id, url, token?, authentication?, tenant? }`), but the
  validator on `tasks/pushNotificationConfig/set` required the v0.3
  nested `pushNotificationConfig` field on every protocol version. A
  v1.0 client that received a config from `get`/`list` and tried to send
  it back to `set` would be rejected with `InvalidParams`.

  **Fix.** The validator branches on `protocolVersion`. On `1.0` it
  accepts the flat shape (top-level `url`/`id`/`token`/`authentication`);
  on `0.3` it continues to require the nested form. The internal storage
  representation is unchanged — the validator normalizes both inputs
  into the same `{ taskId, pushNotificationConfig: { ... } }` value the
  store keys on.

  `get`, `list`, and `delete` already branched on protocol version; only
  `set` was missing the v1.0 path.

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - The SSE stream parser now surfaces mid-stream JSON-RPC error envelopes
  as thrown errors instead of silently dropping them.

  Closes [#142](https://github.com/planetarium/a2x/issues/142) (fix 5 of 5).

  **Why.** When a server-side handler threw mid-stream,
  `DefaultRequestHandler._wrapStreamInJsonRpc` yielded a single JSON-RPC
  error envelope (`{ jsonrpc, id, error: { code, message, data? } }`)
  before closing the connection — exactly as the streaming guide already
  documents. But `parseSSEStream`'s `unwrapData` only unwrapped `result`;
  the `error` envelope was classified as a generic `MESSAGE` event, and
  the switch in `parseSSEStream` had no `MESSAGE` arm, so the chunk was
  dropped without ever being yielded or thrown. Clients saw the stream
  end as though the task had completed silently.

  **Fix.** `unwrapData` now detects a JSON-RPC error envelope and throws
  an `Error` with the server's `message` and `code`. The thrown error
  propagates out of `parseSSEStream`, terminating the iterator with a
  meaningful message — matching what the streaming guide already
  promises.

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - `toA2x()` and `createA2xRequestListener()` now serve the AgentCard at
  both `/.well-known/agent.json` and `/.well-known/agent-card.json`.

  Closes [#142](https://github.com/planetarium/a2x/issues/142) (fix 3 of 5).

  **Why.** The SDK's own `resolveAgentCard()` tries the modern
  `/.well-known/agent-card.json` first and falls back to the v0.3
  `/.well-known/agent.json`. The Next.js samples already expose both
  routes, but plain `toA2x()` users only got the legacy path — a client
  that hit the modern path first received a 404 and only saw the card
  after a fallback round trip (or, with strict client configurations,
  not at all).

  **Fix.** Both well-known paths route to `handler.getAgentCard()` and
  return the same body. No other behavior change.

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - `@a2x/sdk/client` no longer pulls `x402` into the bundle at build time
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

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - Every x402 settlement receipt now carries the `payer` address, including
  failure rows.

  Closes [#143](https://github.com/planetarium/a2x/issues/143) (fix 2 of 4).

  **Why.** x402-v1 §5.3.2 requires the payer wallet address on every
  receipt the merchant emits, success or failure. Before, the SDK
  populated `payer` only on success rows; failure receipts went out
  without it, breaking spec-conformant downstream auditors.

  **Fix.** `payer: string` is now required on the internal X402Receipt
  type, and both the blocking and streaming executor paths thread the
  payer address into every receipt — including the failure-row branch
  that previously omitted it.

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - Add `rejectX402Payment(task)` primitive and let `onPaymentRequired`
  return `false` to send a payment-rejected message on the merchant's
  task.

  Closes [#143](https://github.com/planetarium/a2x/issues/143) (fix 1 of 4).

  **Why.** Per a2a-x402 v0.2 §5.4.2, a payer that declines an x402
  challenge SHOULD send a payment-rejected message back on the same task
  so the merchant can clean up. Throwing from `onPaymentRequired` in
  `A2XClient` aborted locally without telling the server, leaving the
  task in a permanent `payment-required` limbo.

  **Fix.** New export `rejectX402Payment(task)` builds the spec-shaped
  rejection metadata for a given task. `A2XClient.onPaymentRequired`
  recognizes a `false` return value and submits the rejection on the
  same task automatically. Throwing still aborts locally for callers who
  prefer that semantics; returning `false` ends the merchant's task
  cleanly.

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - `A2XClient` now decides x402 outcomes on the **latest** receipt plus the
  task state, recognizes the server-side `retryOnFailure` re-prompt, and
  adds an opt-in `maxRetries` for automatic re-sign on the same task.

  Closes [#143](https://github.com/planetarium/a2x/issues/143) (fix 4 of 4).

  **Why.** The pre-fix client scanned the full receipt history and threw
  on _any_ historical failure, even when the merchant had since prompted
  the payer to retry and a successful receipt followed. That mishandled
  the spec's intended retry flow (a2a-x402 v0.2 §5.5): a failed receipt
  followed by `input-required + payment-required` is a re-prompt, not a
  terminal failure.

  **Fix.** `_evaluatePaymentOutcome` now reads the latest receipt and
  the task state together. A re-prompt (input-required + payment-required
  metadata) is surfaced to `onPaymentRequired` instead of throwing, so
  callers can decide whether to re-sign. New
  `A2XClientX402Options.maxRetries` (default `0`) opts into automatic
  re-sign on the same task — the client signs, submits, observes the
  outcome, and loops up to `maxRetries + 1` total attempts before giving
  up.

- [#146](https://github.com/planetarium/a2x/pull/146) [`94dffb5`](https://github.com/planetarium/a2x/commit/94dffb5254a450945a021963b023407fb9fecaba) Thanks [@ost006](https://github.com/ost006)! - `signX402Payment` now rejects unsupported `x402Version` values up front
  with a typed `X402InvalidVersionError` instead of crashing inside the
  underlying `createPaymentHeader` call.

  Closes [#143](https://github.com/planetarium/a2x/issues/143) (fix 3 of 4).

  **Why.** x402-v1 §9 lists `invalid_x402_version` as a defined error
  code. The SDK never surfaced it: a non-1 `x402Version` in a payment
  requirement crashed inside `x402.createPaymentHeader` with an opaque
  error message, leaving callers no way to handle the version mismatch
  without parsing strings.

  **Fix.** New `X402InvalidVersionError` (exported alongside the other
  `X402*Error` classes) is thrown from `signX402Payment` when the
  requirement's `x402Version` is not `1`. The error carries the spec
  code `invalid_x402_version` (also added to `X402_ERROR_CODES` as
  `INVALID_X402_VERSION`) so callers can branch on it.

## 0.11.0

### Minor Changes

- [#138](https://github.com/planetarium/a2x/pull/138) [`b687ae2`](https://github.com/planetarium/a2x/commit/b687ae2212ada1eff33bfcffbca0a7ac6cef5b64) Thanks [@ost006](https://github.com/ost006)! - Remove the `version` parameter from `A2XAgent.getAgentCard()` and
  `DefaultRequestHandler.getAgentCard()`. The card is now always rendered in the
  agent's configured `protocolVersion` — the same wire format the server actually
  speaks.

  Closes [#133](https://github.com/planetarium/a2x/issues/133).

  **Why.** The server's wire format is fixed at construction time (the
  `protocolVersion` chosen on `new A2XAgent({...})` selects a single
  `responseMapper`). Letting `getAgentCard(version)` render a card in a different
  version published a contract the server could not honor: response shapes
  (`TASK_STATE_COMPLETED` vs `'completed'`), role/part encoding (`ROLE_USER` vs
  `'user'`, `kind` discriminator presence), and `pushNotificationConfig/{set,delete}`
  param shape are all bound to the configured version. A v1.0 agent serving a
  v0.3 card silently broke every call from a conforming v0.3 client, because
  `A2XClient.detectProtocolVersion()` honors the card's declared version
  absolutely.

  **Breaking — removals.**

  - `A2XAgent.getAgentCard(version?)` — the `version` parameter is removed.
  - `DefaultRequestHandler.getAgentCard(version?)` — the `version` parameter is
    removed.
  - The `?version=` query string on `GET /.well-known/agent.json` (built-in
    `to-a2x` HTTP server) is no longer honored.

  In-tree callers that already passed no argument (`samples/express`,
  `samples/nextjs`, `samples/nextjs-skill`, `samples/nextjs-x402`) are
  unaffected. Callers that previously did `getAgentCard('0.3')` against a v1.0
  agent (or vice versa) were creating the foot-gun this fix removes — the
  correct migration is to construct a separate `A2XAgent` with the desired
  `protocolVersion`:

  ```ts
  // Before — silently broken: card said v0.3, wire still spoke v1.0
  const card03 = a2xAgent.getAgentCard("0.3");

  // After — one agent per wire format
  const a2xAgentV03 = new A2XAgent({
    taskStore,
    executor,
    protocolVersion: "0.3",
  });
  const card03 = a2xAgentV03.getAgentCard();
  ```

- [#138](https://github.com/planetarium/a2x/pull/138) [`ac24460`](https://github.com/planetarium/a2x/commit/ac24460bd24b96c640786f9a023b9a77be910688) Thanks [@ost006](https://github.com/ost006)! - Align `MessageSendConfiguration` and `TaskQueryParams` with spec a2a-v0.3.
  Three drift fixes plus an `A2XClient` ergonomic gap.

  Closes [#120](https://github.com/planetarium/a2x/issues/120).

  **Breaking — renames.** `SendMessageConfiguration.returnImmediately`
  (SDK-private, inverted) is replaced with `blocking` (spec-canonical). The
  client's wire-emit path used to translate `returnImmediately → blocking`; that
  translation is now a no-op passthrough.

  ```ts
  // Before
  client.sendMessage({ message, configuration: { returnImmediately: true } });

  // After
  client.sendMessage({ message, configuration: { blocking: false } });
  ```

  **New — inline push-notification config.**
  `SendMessageConfiguration.pushNotificationConfig` is now honored. The request
  handler registers the inline config in the configured
  `PushNotificationConfigStore` before kicking off execution, so clients can
  subscribe in a single round-trip. Throws `PushNotificationNotSupported` when
  no store is configured. Pairs with the actual delivery wiring shipping in this
  release.

  **Fix — `tasks/get` honors `historyLength`.** The method was wired to
  `_validateTaskIdParams` and silently ignored the spec's
  `TaskQueryParams.historyLength`. Added a dedicated `_validateTaskQueryParams`
  validator (rejects non-integer / negative values) and a `sliceHistory()`
  helper that trims the response Task's `history` to the requested bound. The
  same slicing applies on the unary `message/send` response.

  **New — `A2XClient.getTask({ historyLength?, metadata? })`.** The spec's bound
  is now reachable from the public client API.

  Spec refs:

  - v0.3 §`MessageSendConfiguration` (`a2a-v0.3.0.json:1669-1693`)
  - v0.3 §`TaskQueryParams` (`a2a-v0.3.0.json:2385-2406`)
  - v0.3 §`GetTaskRequest.params` (`a2a-v0.3.0.json:1090`) — uses
    `TaskQueryParams`, not `TaskIdParams`.

- [#138](https://github.com/planetarium/a2x/pull/138) [`ac24460`](https://github.com/planetarium/a2x/commit/ac24460bd24b96c640786f9a023b9a77be910688) Thanks [@ost006](https://github.com/ost006)! - Deliver push-notification webhooks on terminal task state, and stop falsely
  advertising the capability when no sender is wired.

  Closes [#119](https://github.com/planetarium/a2x/issues/119).

  **Why.** The SDK accepted `tasks/pushNotificationConfig/{set,get,list,delete}`
  calls and persisted configs to the store, but no code ever POSTed to the
  webhook URL when a task transitioned. Worse, the AgentCard auto-flipped
  `capabilities.pushNotifications: true` as soon as a config store was wired —
  spec-aware clients that read the capability and skipped polling never received
  any notification, and the task appeared stuck.

  **New — `PushNotificationSender` interface.** Pluggable sender abstraction
  plus a default `FetchPushNotificationSender` that POSTs the JSON-encoded task
  body to `config.url`. Forwards `token` as `X-A2A-Notification-Token` and
  `Bearer` credentials from `authentication`. Best-effort by spec — delivery
  failures are logged via an injectable `onError` callback, never thrown into
  the task pipeline.

  ```ts
  import { A2XAgent, FetchPushNotificationSender } from "@a2x/sdk";

  const a2xAgent = new A2XAgent({
    taskStore,
    executor,
    pushNotificationConfigStore, // existing
    pushNotificationSender: new FetchPushNotificationSender(), // new
  });
  ```

  **Behavior change — capability auto-derivation tightened.**
  `capabilities.pushNotifications` now flips to `true` only when **both** a
  `PushNotificationConfigStore` **and** a `PushNotificationSender` are wired. An
  explicit value via `setPushNotifications()` still wins. This stops the SDK
  from shipping a false-positive AgentCard. Existing deployments that wired only
  a store will see the capability flip from `true` (incorrect, never delivered)
  to `false` (correct) until a sender is added.

  **Wiring.** `DefaultRequestHandler` invokes the sender on terminal state
  (after `message/send` completes and after the streaming generator yields a
  terminal event). Fire-and-forget so a slow webhook can't stall the response
  path.

  Tests cover capability auto-derivation in both directions, webhook fire on
  terminal state from both `message/send` and `message/stream`,
  `FetchPushNotificationSender` headers (token, Bearer auth), and
  transport-failure resilience.

- [#138](https://github.com/planetarium/a2x/pull/138) [`ac24460`](https://github.com/planetarium/a2x/commit/ac24460bd24b96c640786f9a023b9a77be910688) Thanks [@ost006](https://github.com/ost006)! - Make `resource` and `description` required on `X402Accept`. The x402 executor
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
  agent.addExtension(
    { uri: X402_EXTENSION_URI },
    {
      accepts: [{ scheme: "exact", network: "base", maxAmountRequired: "..." }],
    }
  );

  // After — required fields enforced at compile time
  agent.addExtension(
    { uri: X402_EXTENSION_URI },
    {
      accepts: [
        {
          scheme: "exact",
          network: "base",
          maxAmountRequired: "...",
          resource: "https://api.example.com/premium",
          description: "Premium agent access",
        },
      ],
    }
  );
  ```

  Samples, docs, and test fixtures are updated to pass real values.

### Patch Changes

- [#138](https://github.com/planetarium/a2x/pull/138) [`ac24460`](https://github.com/planetarium/a2x/commit/ac24460bd24b96c640786f9a023b9a77be910688) Thanks [@ost006](https://github.com/ost006)! - Return HTTP 200 with a JSON-RPC error body for parse failures and handler
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

- [#117](https://github.com/planetarium/a2x/pull/117) [`45463f8`](https://github.com/planetarium/a2x/commit/45463f8079cc2c3a48823e015e5add1d6b70d5ea) Thanks [@ost006](https://github.com/ost006)! - Stop logging a `console.warn` from
  `OAuth2DeviceCodeAuthorization.toV03Schema()`. The warning fired on every v0.3
  AgentCard render — i.e. on every `GET /.well-known/agent.json?version=0.3` and
  every `agent/getAuthenticatedExtendedCard` call — even though emitting Device
  Code as a non-standard `oauth2.flows.deviceCode` extension is the SDK's
  intentional behavior. The non-standard nature is already documented on the
  method's JSDoc and in the authentication guide; the per-render log was pure
  noise.

- [#138](https://github.com/planetarium/a2x/pull/138) [`ac24460`](https://github.com/planetarium/a2x/commit/ac24460bd24b96c640786f9a023b9a77be910688) Thanks [@ost006](https://github.com/ost006)! - Wrap each SSE chunk in a JSON-RPC success envelope keyed by the originating
  request id, per spec a2a-v0.3 §`SendStreamingMessageSuccessResponse`. The
  previous wire shape (`event: status_update` / `event: artifact_update` framing
  plus a non-spec `event: done` terminator) was interop-broken with any
  non-a2x peer (Python ADK, official samples, third-party gateways) — it
  worked only because the a2x client parser tolerated both formats.

  Closes [#118](https://github.com/planetarium/a2x/issues/118).

  **Wire shape — before:**

  ```
  event: status_update
  data: {"taskId":"...","status":{...}}

  event: done
  ```

  **Wire shape — after:**

  ```
  data: {"jsonrpc":"2.0","id":<request-id>,"result":{"taskId":"...","status":{...}}}
  ```

  Stream end is signalled by connection close after the terminal status
  (`final: true` in v0.3); the non-spec `event: done` chunk is gone.

  **Changes.**

  - `DefaultRequestHandler.handle()` now wraps the streaming generator in
    JSON-RPC envelopes (`_wrapStreamInJsonRpc`) for both the routed stream
    methods and the auth-required stream synthesis. Mid-stream errors yield a
    single trailing JSON-RPC error envelope instead of throwing, so clients
    keyed on the request id can correlate the failure.
  - `createSSEStream()` is now a generic `data:`-only encoder — drops the
    `event:` field and the trailing `event: done` terminator.
  - The client SSE parser keeps tolerating the legacy framed shape for one
    minor for upgrade compatibility, but emits a one-time deprecation warning
    when it sees it. **The legacy path will be removed in the next minor.**

  Tests, fixtures, and the streaming guides are updated to consume the new
  shape.

## 0.10.1

### Patch Changes

- [#115](https://github.com/planetarium/a2x/pull/115) [`ab17555`](https://github.com/planetarium/a2x/commit/ab1755510d973d8ef1ffdb80fd1403e9e499ee27) Thanks [@ost006](https://github.com/ost006)! - Fix `detectProtocolVersion` (and therefore `A2XClient`) to honor the AgentCard's
  declared top-level `protocolVersion` field before falling back to shape
  heuristics. Per `a2a-v0.3.0.json`, `protocolVersion` is required on v0.3 cards;
  per `a2a-v1.0.0.json`, it does not exist at the top level. The previous
  shape-only check misclassified v0.3 agents that legally advertise
  `supportedInterfaces` for additional transports as v1.0, which skipped the v0.3
  wire transform and shipped message parts without the required `kind`
  discriminator. The server then dropped the parts and rejected the request.

- [#111](https://github.com/planetarium/a2x/pull/111) [`994da9c`](https://github.com/planetarium/a2x/commit/994da9cae3fcf9453b4285dfc79ab844a7165b2d) Thanks [@ost006](https://github.com/ost006)! - Fix `PushNotificationAuthenticationInfo` to match the v1.0 spec on the wire. The
  SDK previously emitted (and accepted) the v0.3 shape `{ schemes: string[] }` even
  on v1.0 transports, which violates `a2a-v1.0.0.json` (`{ scheme: string,
credentials? }`, `additionalProperties: false`). The internal store still keeps
  the v0.3 shape; the v1.0 response mapper now collapses `schemes` to `scheme` on
  output, and the inbound validator on a v1.0 agent now requires the `scheme`
  field and normalizes it back to `[scheme]` for storage. v0.3 agents are
  unchanged.

## 0.10.0

### Minor Changes

- [#106](https://github.com/planetarium/a2x/pull/106) [`257d893`](https://github.com/planetarium/a2x/commit/257d893d21fbf548e34dfe5ef5898bf04344006d) Thanks [@ost006](https://github.com/ost006)! - Align auth failure handling with A2A spec by surfacing failures as a `TaskState.auth-required` task instead of a non-standard `-32008` JSON-RPC error.

  Closes [#94](https://github.com/planetarium/a2x/issues/94).

  **Why.** The SDK previously returned a JSON-RPC error with code `-32008 AuthenticationRequiredError` on auth failures. That code is not part of the spec — v0.3 defines RPC error codes only up to `-32007 AuthenticatedExtendedCardNotConfiguredError`, and v1.0 does not define JSON-RPC error codes at all. A2A v0.3 (`TaskState.auth-required`) and v1.0 (`TASK_STATE_AUTH_REQUIRED`) both reserve a Task lifecycle state for this exact case. The SDK's own `A2XClient` token-refresh path was gated on `response.status === 401`, an HTTP status the server never produced — so it was unreachable in practice.

  **Server.** `DefaultRequestHandler` now branches on the failing request method:

  - `message/send` returns a Task with `status.state: 'auth-required'` (HTTP `200`).
  - `message/stream` emits a single `TaskStatusUpdateEvent` carrying `auth-required` and closes the stream (HTTP `200`).
  - All other methods (`tasks/get`, `tasks/cancel`, `tasks/pushNotificationConfig/*`, `agent/getAuthenticatedExtendedCard`) have no task-shaped response, so they fall back to spec-defined `-32600 InvalidRequest` with a descriptive message.

  The synthesized auth-required task is ephemeral — it's not persisted to the task store, so unauthenticated callers cannot allocate task IDs.

  **Client.** `A2XClient` no longer inspects `response.status === 401`. Instead, after parsing a `message/send` response or buffering the first event of a `message/stream` response, it checks for `status.state === 'auth-required'`. When `AuthProvider.refresh()` is configured, the client refreshes credentials and retries once — both for blocking and streaming calls. When `refresh()` is not configured, the auth-required task / event is returned to the caller unchanged.

  **Breaking — removals.** `AuthenticationRequiredError` and `A2A_ERROR_CODES.AUTHENTICATION_REQUIRED` (`-32008`) are removed. Consumers that imported either symbol must migrate to inspecting the Task state. HTTP status remains `200` in all cases — no host adapter changes are required (Next.js routes, Express handlers, the built-in `to-a2x` server, etc.).

## 0.9.0

### Minor Changes

- [#102](https://github.com/planetarium/a2x/pull/102) [`52093d8`](https://github.com/planetarium/a2x/commit/52093d883218530717ffa92178fdb3110ce9d0f4) Thanks [@ost006](https://github.com/ost006)! - Align `@a2x/sdk/x402` with a2a-x402 v0.2 spec, and fold x402 handling into `A2XClient` natively.

  Closes [#92](https://github.com/planetarium/a2x/issues/92). Two-part change:

  1. Six spec-conformance fixes (one MUST violation, five drift gaps).
  2. `X402Client` is removed — `A2XClient` itself runs the Standalone Flow when given an `x402` option, so callers no longer have to know up front whether the target agent gates on x402.

  **Breaking — client surface.** The `X402Client` wrapper class is gone. Migrate by passing the same options to `A2XClient` instead:

  ```ts
  // Before
  import { X402Client } from "@a2x/sdk/x402";
  const x402 = new X402Client(new A2XClient(url), { signer });
  await x402.sendMessage({ message });

  // After
  import { A2XClient } from "@a2x/sdk/client";
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

## 0.8.0

### Minor Changes

- [#89](https://github.com/planetarium/a2x/pull/89) [`5a5c858`](https://github.com/planetarium/a2x/commit/5a5c858486212131dae55a662f6b18160a1bf1fd) Thanks [@ost006](https://github.com/ost006)! - Refactor `A2XAgent` capabilities API into focused builder methods.

  `setCapabilities()` is now `@deprecated` and will be removed in the next major.
  In the meantime, `setCapabilities({ extensions: [...] })` appends instead of
  overwriting so multi-source callers no longer clobber one another.

  New methods:

  - `addExtension(ext)` / `addExtension(uri, opts?)` — append to
    `capabilities.extensions`. Append-only, never drops earlier entries.
  - `setPushNotifications(enabled)` — override the auto-derived flag. The
    default is `true` when the constructor receives a
    `pushNotificationConfigStore` and `false` otherwise, so most callers no
    longer need to touch it.
  - `setStateTransitionHistory(enabled)` — v0.3-only flag (silently dropped
    from v1.0 cards).

  `capabilities.streaming` continues to be auto-extracted from
  `runConfig.streamingMode`, and `capabilities.extendedAgentCard` is still
  auto-set by `setAuthenticatedExtendedCardProvider()`.

  Migration:

  ```ts
  // Before
  a2xAgent.setCapabilities({
    pushNotifications: true,
    extensions: [{ uri: X402_EXTENSION_URI, required: true }],
    stateTransitionHistory: true,
  });

  // After
  a2xAgent
    .addExtension({ uri: X402_EXTENSION_URI, required: true })
    .setStateTransitionHistory(true);
  // pushNotifications: true is auto-derived from pushNotificationConfigStore.
  ```

## 0.7.0

### Minor Changes

- [#72](https://github.com/planetarium/a2x/pull/72) [`53e8e92`](https://github.com/planetarium/a2x/commit/53e8e928ed71e23efba670ee88ffd2e56b1046cc) Thanks [@ost006](https://github.com/ost006)! - Add a2a-x402 v0.2 payment support via a new `@a2x/sdk/x402` subpath.

  - **Server**: `X402PaymentExecutor` wraps any `AgentExecutor` and gates
    incoming messages behind on-chain payment. Emits `payment-required`
    with `X402PaymentRequiredResponse` when unpaid; on a signed
    `PaymentPayload` the SDK verifies and settles through a pluggable
    facilitator, then runs the inner executor and attaches a
    `X402SettleResponse` receipt to the completed task.
  - **Client**: `signX402Payment(task, { signer })` produces the metadata
    block a caller attaches to the follow-up `message/send`; `X402Client`
    wraps `A2XClient` and handles the full payment dance automatically.
  - **Types/constants**: `X402_EXTENSION_URI`, `X402_METADATA_KEYS`,
    `X402_PAYMENT_STATUS`, `X402_ERROR_CODES`, plus re-exports of
    `X402PaymentRequirements`, `X402PaymentPayload`, `X402SettleResponse`,
    `X402PaymentRequiredResponse`.
  - **Request handler**: `message/send` and `message/stream` now honor
    `message.taskId` and continue the referenced task when it's live and
    non-terminal, unblocking mid-task hand-offs like x402's
    `payment-required → payment-submitted`.

  `x402` and `viem` are added as optional peer dependencies — callers who
  don't use x402 don't need to install them. Pins to x402 v1
  (`x402Version: 1`), matching a2a-x402 v0.2.

## 0.6.0

### Minor Changes

- [#47](https://github.com/planetarium/a2x/pull/47) [`1b6b6a6`](https://github.com/planetarium/a2x/commit/1b6b6a6c6d374f4c3cd197a3ab27f3f6114b9a4c) Thanks [@ost006](https://github.com/ost006)! - feat(skills): integrate Claude Agent Skills open standard runtime

  Adds optional `skills` support to `LlmAgent` so any agent can load an
  open Claude Agent Skills directory (SKILL.md frontmatter + body + bundled
  files + scripts) or inline skills via `defineSkill()`. On activation the
  SDK registers three provider-agnostic builtin tools — `load_skill`,
  `read_skill_file`, `run_skill_script` — and injects the skill metadata
  block into the system prompt so Anthropic, OpenAI, and Google providers
  observe identical behaviour (progressive disclosure: eager metadata,
  lazy body, lazy references). Script execution is policy-aware
  (`allow` / `confirm` / `deny`) and audit-hook aware via
  `onScriptExecute`. Zero new runtime dependencies: a minimal YAML
  frontmatter parser is included. Existing agents are unaffected when the
  `skills` option is absent.

### Patch Changes

- [#49](https://github.com/planetarium/a2x/pull/49) [`b506378`](https://github.com/planetarium/a2x/commit/b506378f2592a004dc0faec3b8550d36cdbc3463) Thanks [@ost006](https://github.com/ost006)! - docs: cover SSE disconnect handling, `tasks/resubscribe`, and the authenticated extended card

  Extends the bundled guides to reflect the features landed in PRs [#42](https://github.com/planetarium/a2x/issues/42), [#43](https://github.com/planetarium/a2x/issues/43), [#44](https://github.com/planetarium/a2x/issues/44):

  - `guides/agent/streaming.md` — new "Client disconnect stops the work" and "Resuming a dropped SSE stream" sections, with guidance on wiring `res.on('close')` when hand-rolling an HTTP handler.
  - `guides/client/streaming.md` — new "Resuming a dropped stream" section showing the raw-JSON-RPC `tasks/resubscribe` pattern plus a note on the new cancel-on-disconnect contract.
  - `guides/advanced/manual-wiring.md` — documents `A2XAgentOptions.taskEventBus` with a sketch of a cross-process custom bus.
  - `guides/advanced/extended-agent-card.md` — **new** page covering `setAuthenticatedExtendedCardProvider`, overlay merge semantics, per-principal enrichment, and the `-32007` / `-32008` error codes. Linked from `authentication.md`, `agent-card-versioning.md`, and `manifest.json`.
  - `guides/agent/framework-integration.md` — Express snippet updated to include the `res.on('close')` disconnect wiring.

  Closes [#46](https://github.com/planetarium/a2x/issues/46).

- [#47](https://github.com/planetarium/a2x/pull/47) [`11483ae`](https://github.com/planetarium/a2x/commit/11483ae02b91df5a4d3879454e0b44ef9d54e555) Thanks [@ost006](https://github.com/ost006)! - fix(provider/anthropic): emit tool_use blocks after text blocks in assistant messages

  The Anthropic API treats a trailing tool_use block as the assistant's pending request and expects the next user message to begin with a matching tool_result. When the converter emitted tool_use before text inside the same assistant message, Anthropic rejected the conversation with `tool_use ids were found without tool_result blocks immediately after`, breaking any tool-calling flow where the model produced preamble text alongside a tool call.

## 0.5.0

### Minor Changes

- [#44](https://github.com/planetarium/a2x/pull/44) [`a478936`](https://github.com/planetarium/a2x/commit/a478936a2f0b8df2e3b2094c9d10e7afc50e4242) Thanks [@ost006](https://github.com/ost006)! - feat(a2x): implement `agent/getAuthenticatedExtendedCard` JSON-RPC method

  Adds a builder API `A2XAgent.setAuthenticatedExtendedCardProvider(fn)` that
  lets agent authors declare how to enrich the AgentCard for authenticated
  callers. When set, the SDK automatically advertises the capability on the
  base card (`supportsAuthenticatedExtendedCard` for v0.3,
  `capabilities.extendedAgentCard` for v1.0) and the new JSON-RPC method
  returns a merged card built from the base state plus the provider's overlay.
  Returns `AuthenticationRequiredError` when the call is unauthenticated and
  `AuthenticatedExtendedCardNotConfiguredError` when no provider is
  registered.

  Also corrects the method-name constant in `A2A_METHODS.GET_EXTENDED_CARD`
  from the non-compliant `'agent/authenticatedExtendedCard'` to the
  spec-defined `'agent/getAuthenticatedExtendedCard'`. This was never a
  functional method before, so no external callers are affected.

  Closes [#40](https://github.com/planetarium/a2x/issues/40).

- [#43](https://github.com/planetarium/a2x/pull/43) [`f84648f`](https://github.com/planetarium/a2x/commit/f84648fe52c4d064dd3ba36e079d21de32af6eb0) Thanks [@ost006](https://github.com/ost006)! - feat(transport): implement `tasks/resubscribe` JSON-RPC method

  Adds support for the v0.3 `tasks/resubscribe` method so clients that lose
  an SSE connection mid-task can resume the stream without re-executing
  the agent. Introduces an in-memory `TaskEventBus` (pluggable via
  `A2XAgentOptions.taskEventBus`) that fans events out from `message/stream`
  to any number of resubscribers. Resubscribing to a task in terminal state
  replays a single status-update event with the final state and ends; for
  an unknown task the method returns `TaskNotFoundError`. Closes [#39](https://github.com/planetarium/a2x/issues/39).

### Patch Changes

- [#42](https://github.com/planetarium/a2x/pull/42) [`47add77`](https://github.com/planetarium/a2x/commit/47add777b85f56980cb27c9722f8dc42b804bef6) Thanks [@ost006](https://github.com/ost006)! - fix(transport): terminate server-side execution when SSE client disconnects

  Previously, when an SSE client disconnected mid-task, the server continued executing the full LLM loop (up to 25 calls) because `createSSEStream`'s cancel callback was empty and the built-in HTTP server never listened for `req.on('close')`. Now the cancel callback calls `.return()` on the source generator, `AgentExecutor`'s finally block aborts its internal controller (which PR [#22](https://github.com/planetarium/a2x/issues/22) already wired through to the LLM provider), and the built-in server cancels the stream reader on TCP close. Closes [#20](https://github.com/planetarium/a2x/issues/20).

## 0.4.0

### Minor Changes

- [#38](https://github.com/planetarium/a2x/pull/38) [`4b8757b`](https://github.com/planetarium/a2x/commit/4b8757ba0336555fc6ab0e77e37526cb4ec4c971) Thanks [@ost006](https://github.com/ost006)! - Wire the missing JSON-RPC methods for push notification config management.

  `DefaultRequestHandler` now routes the following methods to
  `PushNotificationConfigStore` when one is injected:

  - `tasks/pushNotificationConfig/set`
  - `tasks/pushNotificationConfig/get`
  - `tasks/pushNotificationConfig/list`

  Both A2A v0.3 (`{ id, pushNotificationConfigId }`) and v1.0 (`{ taskId, id }`)
  wire shapes are normalized by the handlers, mirroring the existing
  `tasks/pushNotificationConfig/delete` behavior. Agents that do not inject a
  `pushNotificationConfigStore` continue to receive
  `PushNotificationNotSupportedError` (-32003) as before.

  `tasks/resubscribe` and `agent/authenticatedExtendedCard` remain unimplemented
  and will be addressed in a follow-up phase.

## 0.3.0

### Minor Changes

- [#36](https://github.com/planetarium/a2x/pull/36) [`b57f711`](https://github.com/planetarium/a2x/commit/b57f711eca332fad3d64c09d1beeca7165d9fae1) Thanks [@ost006](https://github.com/ost006)! - Bundle a Guides directory (`docs/`) with the npm package. The new tree under
  `node_modules/@a2x/sdk/docs/` contains progressive-disclosure guides (Getting
  Started → Agent → Client → Advanced) plus a `manifest.json` describing the
  navigation. The `a2x-web` documentation site consumes these files at build
  time so guides stay version-locked to the SDK that introduced them.

  No API surface change; this release only enlarges the published tarball.

## 0.2.0

### Minor Changes

- [#28](https://github.com/planetarium/a2x/pull/28) [`cc6b1eb`](https://github.com/planetarium/a2x/commit/cc6b1eb3bf0d77a52f5c46a4892aaae57c9f85b1) Thanks [@ost006](https://github.com/ost006)! - Emit and consume OAuth2 Device Code flow as a non-standard extension on A2A
  v0.3 AgentCards.

  Previously, `OAuth2DeviceCodeAuthorization.toV03Schema()` returned `null` and
  the scheme was silently stripped from v0.3 cards — headless/CLI clients that
  rely on device code flow could not negotiate against v0.3 peers even though
  both sides already supported it internally.

  The scheme now emits `oauth2.flows.deviceCode` on v0.3 cards (mirroring the
  v1.0 shape) and `normalizeOAuth2FlowsV03()` consumes it. OpenAPI 3.0 does
  not standardize this flow, so a warning is still logged on emission and
  strict third-party v0.3 parsers may ignore the unknown flow.

## 0.1.1

### Patch Changes

- [#14](https://github.com/planetarium/a2x/pull/14) [`91ba909`](https://github.com/planetarium/a2x/commit/91ba90916aac0a0299eaa876df458230afca64da) Thanks [@ost006](https://github.com/ost006)! - Add comprehensive README for npm package page
