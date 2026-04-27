# @a2x/sdk

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
