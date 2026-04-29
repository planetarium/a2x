---
'@a2x/sdk': patch
---

`tasks/pushNotificationConfig/set` now accepts the v1.0 flat input
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
