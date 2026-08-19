# Streaming

`A2XClient.sendMessageStream()` returns an `AsyncGenerator` that yields typed A2A events as they arrive via SSE. The underlying implementation lives in `src/client/sse-parser.ts` and handles two SSE wire formats interoperably.

---

## Basic Usage

```typescript
import { A2XClient } from '@a2x/sdk/client';
import type { SendMessageParams } from '@a2x/sdk';
import crypto from 'node:crypto';

const client = new A2XClient(AGENT_URL, { authProvider });

const params: SendMessageParams = {
  message: {
    messageId: crypto.randomUUID(),
    role: 'user',
    parts: [{ text: 'write a haiku about concurrency' }],
  },
};

for await (const event of client.sendMessageStream(params)) {
  if ('status' in event) {
    // TaskStatusUpdateEvent
    console.log('status:', event.status.state);
    if (event.status.message?.parts) {
      for (const p of event.status.message.parts) {
        if ('text' in p) process.stderr.write(p.text);
      }
    }
  } else {
    // TaskArtifactUpdateEvent
    for (const p of event.artifact.parts) {
      if ('text' in p) process.stdout.write(p.text);
      else if ('data' in p) console.log(p.data);
    }
  }
}
```

---

## Event Types

Each yielded value is one of:

```typescript
import type { TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from '@a2x/sdk';

type Event = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;
```

Discriminate by presence of `status` vs. `artifact`:

```typescript
if ('status' in event) { /* status update */ }
else { /* artifact update */ }
```

Both include `taskId` and `contextId`. Status updates carry a `TaskStatus` with `state` (one of `TaskState`) and an optional `message`. Artifact updates carry an `Artifact` with `parts`.

---

## Terminal States

The stream ends (generator completes) when:

1. A legacy server sends `event: done`, or
2. A status event with `final: true` arrives and the state is terminal (`completed`, `failed`, `canceled`, `rejected`), or
3. The underlying HTTP response body closes cleanly.

`TERMINAL_STATES` (exported from `@a2x/sdk`) is the canonical set:

```typescript
import { TERMINAL_STATES } from '@a2x/sdk';
// ReadonlySet<TaskState>: completed, failed, canceled, rejected
```

The set contains normalized lowercase `TaskState` values and `Set.has()` is case-sensitive. Events parsed by the SDK are normalized before they reach this check.

The generator does **not** automatically time out — if the server never signals termination, you will hang until the connection drops. Always use either a client-supplied abort or a wrapper with a timeout.

---

## Cancellation

Pass an `AbortSignal`:

```typescript
const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), 30_000);

try {
  for await (const event of client.sendMessageStream(params, ac.signal)) {
    // …
  }
} catch (err) {
  if (ac.signal.aborted) console.log('Aborted');
  else throw err;
} finally {
  clearTimeout(timer);
}
```

The signal is passed to `fetch`. Aborting terminates the underlying HTTP request, which closes the SSE body, which ends the generator with the `AbortError` propagated out.

If you also need to tell the **agent** to cancel (stop billing, release the task), follow up with a separate call:

```typescript
await client.cancelTask(taskId);
```

The `taskId` is available on every event's `taskId` field after the first status update.

---

## x402 Payment Streams

When the client is constructed with `x402`, the same generator owns the payment round trip. It yields the initial `payment-required` status, invokes `onPaymentRequired`, signs and resubmits when approved, then continues yielding verification, work, artifact, and completion events. Configure batch support with durable `batchSettlement` storage and opt into default selection separately with `allowBatchSettlement`. The default selector's `allowUpto`, `allowBatchSettlement`, and `maxRetries` rules match blocking `sendMessage`; a custom `selectRequirement` bypasses the two scheme opt-in flags.

Treat yielded payment-required events, approval envelopes, and selector
candidates as read-only. The current payer can reuse those live objects for
later signing; mutation isolation is tracked in
[#241](https://github.com/planetarium/a2x/issues/241).

Unlike blocking `sendMessage`, a terminal unsuccessful payment receipt in a stream is yielded as a failed status; the stream does not convert it to `X402PaymentFailedError`. Inspect terminal status and x402 receipt metadata in the streamed events. Batch reconciliation failures still throw `X402ReconciliationError` before an unsafe terminal event can be yielded.

Breaking out after a payment payload has been submitted can leave the result ambiguous, especially for `batch-settlement`. Use durable channel storage, route a channel through one process owner or a durable cross-process reservation, and handle `X402ReconciliationError` as described in the [x402 payments guide](https://github.com/planetarium/a2x/blob/main/packages/a2x/docs/guides/advanced/x402-payments.md).

---

## Error Handling During a Stream

The SDK distinguishes two error paths:

### Non-stream response (wrong content type)

If the server returns `application/json` instead of `text/event-stream` (e.g. because authentication failed and the server shortcuts to a JSON-RPC error), the client parses it and throws the mapped `A2AError`:

```typescript
try {
  for await (const event of client.sendMessageStream(params)) { /* … */ }
} catch (err) {
  if (err instanceof InvalidParamsError) { /* … */ }
  else throw err;
}
// Protocol-level task auth failure is not thrown — it arrives as an
// `auth-required` status event. HTTP auth failures still throw InternalError.
```

All error classes importable from `@a2x/sdk`. See [error-handling.md](./error-handling.md) for the full list.

### Error event inside the stream

If the server emits `event: error\ndata: …`, the generator throws an `Error` with the server's message:

```typescript
try {
  for await (const event of client.sendMessageStream(params)) { /* … */ }
} catch (err) {
  console.error('Stream error:', err instanceof Error ? err.message : err);
}
```

Data-only JSON-RPC streams may also carry a JSON-RPC error envelope in a `data:` chunk. The parser terminates the generator and throws an error containing the remote message, code, and data. A server may instead return a non-SSE JSON-RPC error response before streaming begins; that response is mapped to the exported `A2AError` subclass.

### Authentication during streaming

The client buffers exactly the first stream event. If that event is an `auth-required` status, the provider implements `refresh()`, and schemes were resolved, the client refreshes credentials and retries the stream once before yielding anything. An artifact or other event first means a later `auth-required` status is yielded without automatic refresh. If the retried stream is also `auth-required`, that event is yielded normally.

An HTTP 401 is different: it throws `InternalError('HTTP 401: Unauthorized')` immediately and does not invoke the provider. Refresh the host credential and construct a fresh client only if the remote integration uses transport-level 401 instead of the A2A `auth-required` state.

---

## SSE Wire Formats

The parser handles the standard format plus a temporary legacy format for upgrade compatibility:

### Legacy format: explicit event names

```
event: status_update
data: {"taskId":"…","status":{"state":"working"}}

event: artifact_update
data: {"taskId":"…","artifact":{"parts":[{"text":"hi"}]}}

event: done
data: {}

event: error
data: {"error":"something broke"}
```

The parser logs a one-time deprecation warning when it sees this format.

### Standard format: data-only with JSON-RPC wrapping

```
data: {"jsonrpc":"2.0","id":1,"result":{"kind":"status-update","taskId":"…","status":{"state":"working"}}}

data: {"jsonrpc":"2.0","id":1,"result":{"kind":"artifact-update","artifact":{"parts":[…]}}}
```

For the standard format, the parser:

1. Unwraps the JSON-RPC envelope (takes `result`).
2. Detects event type via the `kind` discriminator or structural cues (`status` + `taskId` without `artifacts` → status-update; `artifact` → artifact-update).
3. Throws when a chunk contains a JSON-RPC `error` envelope.
4. Stops when a status event with `final: true` and terminal state arrives.

---

## Parts in Events

Artifact and message parts can be text, data, or file references. Pattern-match on presence of fields:

```typescript
for (const part of event.artifact.parts) {
  if ('text' in part) {
    // TextPart — { text: string, metadata? }
  } else if ('data' in part) {
    // DataPart — { data: unknown, metadata? }
  } else if ('raw' in part) {
    // FilePart (inline) — { raw: Uint8Array | string, mediaType?, filename?, metadata? }
  } else if ('url' in part) {
    // FilePart (by reference) — { url: string, mediaType?, filename?, metadata? }
  }
}
```

For v0.3 servers, file parts arrive as `{ kind: 'file', file: { bytes | uri, mimeType, name } }`. The SDK normalizes these to the internal shape above before yielding.

---

## Buffering

The SSE parser reads the response body via `ReadableStream`, decodes with `TextDecoder`, and buffers chunks until a complete event block (`\n\n`) arrives. Very large event payloads are reassembled across chunks — you don't need to worry about partial events.

If you want backpressure (e.g. throttle UI updates), consume the generator with throttling:

```typescript
let lastRender = 0;
for await (const event of client.sendMessageStream(params)) {
  // accumulate
  if (Date.now() - lastRender > 50) {
    render();
    lastRender = Date.now();
  }
}
render(); // final flush
```

---

## Accumulating an Artifact

Artifact events are typically **chunks** — the agent streams text progressively. To reconstruct a full artifact:

```typescript
const buffers = new Map<string, string>();  // artifactId → concatenated text

for await (const event of client.sendMessageStream(params)) {
  if ('artifact' in event) {
    const artifactId = event.artifact.artifactId ?? 'default';
    const text = event.artifact.parts
      .filter(p => 'text' in p)
      .map(p => (p as { text: string }).text)
      .join('');
    buffers.set(artifactId, (buffers.get(artifactId) ?? '') + text);
  }
}

console.log(buffers.get('default'));
```

The `append` / `lastChunk` flags on `TaskArtifactUpdateEvent` indicate whether to append to a running buffer (`append: true`) or replace (`append: false`). Use them if your agent sets them:

```typescript
if (event.append) buffer += text;
else buffer = text;

if (event.lastChunk) {
  finalize(buffer);
  buffer = '';
}
```

---

## Testing Streams

For a fake agent, implement a minimal SSE server:

```typescript
import http from 'node:http';

http.createServer((req, res) => {
  if (req.url !== '/a2a') { res.writeHead(404).end(); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  res.write('event: status_update\n');
  res.write('data: {"taskId":"t1","contextId":"c1","status":{"state":"working"}}\n\n');
  setTimeout(() => {
    res.write('event: artifact_update\n');
    res.write('data: {"taskId":"t1","artifact":{"parts":[{"text":"hello"}]}}\n\n');
    res.write('event: done\ndata: {}\n\n');
    res.end();
  }, 100);
}).listen(4000);
```

Serve a minimal agent card on `/.well-known/agent.json` and point your `A2XClient` at it.
