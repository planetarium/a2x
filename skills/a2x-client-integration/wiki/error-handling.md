# Error Handling

`A2XClient` surfaces three distinct error layers. Handle them separately.

---

## Three Error Layers

| Layer | Source | Surface |
|-------|--------|---------|
| **Transport** | `fetch` threw, DNS failure, connection refused | `TypeError` (often with `code === 'ECONNREFUSED'`), `AbortError`, `fetch` spec errors |
| **HTTP** | Any non-2xx HTTP response | `InternalError('HTTP <status>: <statusText>')` |
| **Protocol** | Valid HTTP response containing a JSON-RPC error | Subclass of `A2AError` (e.g. `TaskNotFoundError`, `InvalidParamsError`) |

> **Auth failures are not thrown.** Per the A2A spec, an authentication failure surfaces as a returned `Task` in the `auth-required` state — *not* a JSON-RPC error. `A2XClient` refreshes credentials once and retries; if it is still `auth-required`, it returns that task as-is. Check `task.status.state === 'auth-required'` rather than catching an error. See [The Auth-Required Path](#the-auth-required-path).

Importable error types:

```typescript
import {
  A2AError,                            // base
  InternalError,
  InvalidRequestError,
  MethodNotFoundError,
  InvalidParamsError,
  JSONParseError,
  TaskNotFoundError,
  TaskNotCancelableError,
  PushNotificationNotSupportedError,
  UnsupportedOperationError,
  ContentTypeNotSupportedError,
  InvalidAgentResponseError,
  AuthenticatedExtendedCardNotConfiguredError,
  VersionNotSupportedError,
  A2A_ERROR_CODES,
} from '@a2x/sdk';
```

---

## Error Code → Class Map

This is the mapping the client uses internally when it sees a JSON-RPC error:

| Code | Class | Meaning |
|------|-------|---------|
| `-32700` | `JSONParseError` | Server couldn't parse the request |
| `-32600` | `InvalidRequestError` | Request shape invalid |
| `-32601` | `MethodNotFoundError` | Method not implemented by server |
| `-32602` | `InvalidParamsError` | Parameters invalid (typed/shape) |
| `-32603` | `InternalError` | Catch-all server error |
| `-32001` | `TaskNotFoundError` | `getTask` / `cancelTask` with unknown id |
| `-32002` | `TaskNotCancelableError` | `cancelTask` on a terminal task |
| `-32003` | `PushNotificationNotSupportedError` | Server doesn't support push config |
| `-32004` | `UnsupportedOperationError` | Operation not allowed here |
| `-32005` | `ContentTypeNotSupportedError` | Unsupported content type |
| `-32006` | `InvalidAgentResponseError` | Agent returned something invalid |
| `-32007` | `AuthenticatedExtendedCardNotConfiguredError` | Extended card requested but not configured |
| `-32009` | `VersionNotSupportedError` | Requested A2A protocol version is unsupported |

The mapping uses `A2A_ERROR_CODES` constants — consult `@a2x/sdk` source if you need the numeric values.

Unknown codes fall through to `InternalError`. **There is no auth-failure error code** — authentication failures are modeled as a `Task` in the `auth-required` state, not a JSON-RPC error (see below).

---

## Practical Error Handling

```typescript
import {
  A2AError,
  TaskNotFoundError,
  InternalError,
} from '@a2x/sdk';

try {
  const task = await client.sendMessage(params);
  // Auth failure is NOT thrown — it comes back as a task state.
  if (task.status.state === 'auth-required') {
    // The client already refreshed once and retried; still auth-required.
    // Surface to user / trigger re-auth UI.
    return { ok: false, reason: 'auth' };
  }
  // …
} catch (err) {
  if (err instanceof TaskNotFoundError) {
    return { ok: false, reason: 'task_missing' };
  }
  if (err instanceof InternalError && /HTTP 401/.test(err.message)) {
    // HTTP authentication failed at the transport layer. A2XClient does not
    // call AuthProvider.refresh() for HTTP status codes.
    return { ok: false, reason: 'auth' };
  }
  if (err instanceof InternalError) {
    // Other HTTP or protocol issues
    return { ok: false, reason: 'server', detail: err.message };
  }
  if (err instanceof A2AError) {
    return { ok: false, reason: err.constructor.name, detail: err.message };
  }
  // Transport-level (fetch threw before a response was obtained)
  if (err instanceof TypeError) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED') return { ok: false, reason: 'unreachable' };
  }
  throw err;
}
```

---

<a id="the-auth-required-path"></a>
## The Auth-Required Path

Authentication refresh is modeled at the protocol layer. When `sendMessage` returns a `Task` in `auth-required` state, the client calls `authProvider.refresh` once and retries the same request. `sendMessageStream` does the same when its first status event is `auth-required`, before yielding that event. If the retry is still `auth-required`, the task or event is surfaced to you. No `A2AError` is thrown for that state.

## HTTP 401 Handling

HTTP 401 is separate from the protocol-level `auth-required` state. For blocking and streaming requests alike, `A2XClient` throws `InternalError('HTTP 401: Unauthorized')` immediately. It does not invoke `AuthProvider.refresh()` or retry based on HTTP status.

If an integration uses HTTP 401 for credential expiry, handle it outside `A2XClient`: refresh the host credential, construct a fresh client so `provide()` runs again, and retry only when duplicate execution is safe. Prefer agents that follow the A2A task-state model for task-creating authentication failures.

---

## Wrapping for Your UX

### Retry on network blips (idempotent ops only)

```typescript
import { InternalError } from '@a2x/sdk';

async function withRetry<T>(fn: () => Promise<T>, attempts = 3): Promise<T> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      const last = i === attempts - 1;
      if (last) throw err;
      if (err instanceof TypeError) continue;          // DNS, connection refused
      if (err instanceof InternalError && /5\d\d/.test(err.message)) continue;
      throw err;
    }
  }
  throw new Error('unreachable');
}

const task = await withRetry(() => client.getTask(taskId));
```

Retry `getTask` and `getAgentCard` when appropriate. After an ambiguous `cancelTask` failure, fetch the task before retrying because the original cancellation may already have succeeded. Never auto-retry `sendMessage` — you may send the same message twice.

### Convert to HTTP status codes (for a Next.js / Express wrapper)

```typescript
function a2aErrorToHttpStatus(err: unknown): number {
  // Note: auth failures are a task state (`auth-required`), not a thrown
  // error — map those to 401 where you read the returned task, not here.
  if (err instanceof InvalidParamsError) return 400;
  if (err instanceof MethodNotFoundError) return 501;
  if (err instanceof TaskNotFoundError) return 404;
  if (err instanceof TaskNotCancelableError) return 409;
  if (err instanceof A2AError) return 500;
  if (err instanceof TypeError) return 502;   // upstream transport
  return 500;
}
```

---

## Logging

Log the error **class name** and **message**. The `A2AError` subclasses have clear class names and user-meaningful messages — they're safe to surface.

Do **not** log:

- The full JSON-RPC request body if it contained sensitive user input
- Headers (they contain your auth tokens)
- Response bodies from token endpoints

Safe to log: endpoint URL, HTTP status, error class name, error message, `taskId` (if applicable), `contextId` (if applicable).

---

## Handling Connection Refused (like the CLI does)

The CLI's `printConnectionError`:

```typescript
export function printConnectionError(err: unknown, url: string): void {
  if (err instanceof TypeError && (err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
    console.error(`Connection refused: ${url}`);
  } else {
    console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
```

`ECONNREFUSED` is the most common "agent not running" symptom in dev. Distinguishing it from "agent reachable but rejected the request" makes the UX much friendlier.
