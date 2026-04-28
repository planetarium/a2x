---
'@a2x/sdk': minor
---

Deliver push-notification webhooks on terminal task state, and stop falsely
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
import { A2XAgent, FetchPushNotificationSender } from '@a2x/sdk';

const a2xAgent = new A2XAgent({
  taskStore,
  executor,
  pushNotificationConfigStore,         // existing
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
