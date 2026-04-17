# Error Handling

`A2XClient` surfaces three distinct error layers. Handle them separately.

---

## Three Error Layers

| Layer | Source | Surface |
|-------|--------|---------|
| **Transport** | `fetch` threw, DNS failure, connection refused | `TypeError` (often with `code === 'ECONNREFUSED'`), `AbortError`, `fetch` spec errors |
| **HTTP** | Non-2xx HTTP response outside the 401-refresh path | `InternalError('HTTP <status>: <statusText>')` |
| **Protocol** | Valid HTTP response containing a JSON-RPC error | Subclass of `A2AError` (e.g. `AuthenticationRequiredError`, `TaskNotFoundError`) |

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
  AuthenticationRequiredError,
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
| `-32004` | `AuthenticationRequiredError` | Authentication required or failed |
| `-32005` | `AuthenticatedExtendedCardNotConfiguredError` | Extended card requested but not configured |
| `-32006` | `ContentTypeNotSupportedError` | Unsupported content type |
| `-32007` | `UnsupportedOperationError` | Operation not allowed here |
| `-32008` | `InvalidAgentResponseError` | Agent returned something invalid |

The mapping uses `A2A_ERROR_CODES` constants — consult `@a2x/sdk` source if you need the numeric values.

Unknown codes fall through to `InternalError`.

---

## Practical Error Handling

```typescript
import {
  A2AError,
  AuthenticationRequiredError,
  TaskNotFoundError,
  InternalError,
} from '@a2x/sdk';

try {
  const task = await client.sendMessage(params);
  // …
} catch (err) {
  if (err instanceof AuthenticationRequiredError) {
    // Protocol-level auth failure. Unlike HTTP 401, the SDK did NOT retry.
    // Surface to user / log / trigger re-auth UI.
    return { ok: false, reason: 'auth' };
  }
  if (err instanceof TaskNotFoundError) {
    return { ok: false, reason: 'task_missing' };
  }
  if (err instanceof InternalError && /HTTP 401/.test(err.message)) {
    // HTTP 401 on a NON-streaming request is usually already handled via refresh.
    // If it reaches here, the refresh also failed. Surface as auth failure.
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

## The 401 Refresh Path

For **non-streaming** requests, the client retries exactly once on HTTP 401 — but only if:

1. `authProvider` was provided, **and**
2. `authProvider.refresh` is defined, **and**
3. `_resolvedSchemes` has been populated (i.e. `provide` has run at least once).

If **all** of those hold:

```
fetch → 401
  ↓
_resolvedSchemes = await authProvider.refresh(_resolvedSchemes)
  ↓
retry fetch exactly once
  ↓
  ├─ 2xx   → parse and return
  └─ any   → throw InternalError('HTTP 401: …') or mapped A2AError
```

Points to remember:

- The retry happens **once**. If the refresh itself throws or the retry also fails, the error is propagated.
- **Streaming requests do not retry.** See [streaming.md](./streaming.md).
- **Protocol-level `AuthenticationRequiredError` (code `-32004`) does not trigger a refresh.** It's a JSON-RPC error, not an HTTP 401. If your agent sends this instead of a 401, wrap your calls to retry manually or reconfigure the server.

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

Only retry **idempotent** calls (`getTask`, `cancelTask`, `getAgentCard`). Never auto-retry `sendMessage` — you may send the same message twice.

### Convert to HTTP status codes (for a Next.js / Express wrapper)

```typescript
function a2aErrorToHttpStatus(err: unknown): number {
  if (err instanceof AuthenticationRequiredError) return 401;
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
