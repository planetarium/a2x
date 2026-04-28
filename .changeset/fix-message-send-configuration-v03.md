---
'@a2x/sdk': minor
---

Align `MessageSendConfiguration` and `TaskQueryParams` with spec a2a-v0.3.
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
