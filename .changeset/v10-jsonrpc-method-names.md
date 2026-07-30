---
"@a2x/sdk": minor
---

`protocolVersion: '1.0'` servers now accept the A2A v1.0 JSON-RPC method names (`SendMessage`, `SendStreamingMessage`, `GetTask`, `CancelTask`, `SubscribeToTask`, `CreateTaskPushNotificationConfig`, `GetTaskPushNotificationConfig`, `ListTaskPushNotificationConfigs`, `DeleteTaskPushNotificationConfig`, `GetExtendedAgentCard`) per spec a2a-v1.0 §9.4, and normalize the v1.0 `ROLE_USER` / `ROLE_AGENT` message roles on inbound messages. v0.3 method spellings remain accepted on v1.0 servers as a legacy-compat extension; `protocolVersion: '0.3'` servers are unchanged and keep rejecting v1.0 spellings. The v1.0 method table is exported as `A2A_METHODS_V10`. (#193)
