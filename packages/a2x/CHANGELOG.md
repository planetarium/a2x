# @a2x/sdk

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
