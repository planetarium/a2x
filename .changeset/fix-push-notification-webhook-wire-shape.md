---
'@a2x/sdk': patch
---

Push notification webhooks now POST the spec-mapped Task wire shape, not
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
