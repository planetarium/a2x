---
"@a2x/sdk": minor
---

Wire the missing JSON-RPC methods for push notification config management.

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
