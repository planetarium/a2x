---
"@a2x/sdk": minor
---

Align auth failure handling with A2A spec by surfacing failures as a `TaskState.auth-required` task instead of a non-standard `-32008` JSON-RPC error.

Closes #94.

**Why.** The SDK previously returned a JSON-RPC error with code `-32008 AuthenticationRequiredError` on auth failures. That code is not part of the spec — v0.3 defines RPC error codes only up to `-32007 AuthenticatedExtendedCardNotConfiguredError`, and v1.0 does not define JSON-RPC error codes at all. A2A v0.3 (`TaskState.auth-required`) and v1.0 (`TASK_STATE_AUTH_REQUIRED`) both reserve a Task lifecycle state for this exact case. The SDK's own `A2XClient` token-refresh path was gated on `response.status === 401`, an HTTP status the server never produced — so it was unreachable in practice.

**Server.** `DefaultRequestHandler` now branches on the failing request method:

- `message/send` returns a Task with `status.state: 'auth-required'` (HTTP `200`).
- `message/stream` emits a single `TaskStatusUpdateEvent` carrying `auth-required` and closes the stream (HTTP `200`).
- All other methods (`tasks/get`, `tasks/cancel`, `tasks/pushNotificationConfig/*`, `agent/getAuthenticatedExtendedCard`) have no task-shaped response, so they fall back to spec-defined `-32600 InvalidRequest` with a descriptive message.

The synthesized auth-required task is ephemeral — it's not persisted to the task store, so unauthenticated callers cannot allocate task IDs.

**Client.** `A2XClient` no longer inspects `response.status === 401`. Instead, after parsing a `message/send` response or buffering the first event of a `message/stream` response, it checks for `status.state === 'auth-required'`. When `AuthProvider.refresh()` is configured, the client refreshes credentials and retries once — both for blocking and streaming calls. When `refresh()` is not configured, the auth-required task / event is returned to the caller unchanged.

**Breaking — removals.** `AuthenticationRequiredError` and `A2A_ERROR_CODES.AUTHENTICATION_REQUIRED` (`-32008`) are removed. Consumers that imported either symbol must migrate to inspecting the Task state. HTTP status remains `200` in all cases — no host adapter changes are required (Next.js routes, Express handlers, the built-in `to-a2x` server, etc.).
