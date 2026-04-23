---
"@a2x/sdk": minor
---

Refactor `A2XAgent` capabilities API into focused builder methods.

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
