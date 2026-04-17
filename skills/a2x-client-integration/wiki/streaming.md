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

1. The server sends `event: done` (a2x server format), or
2. A status event with `final: true` arrives and the state is terminal (`completed`, `failed`, `canceled`, `rejected`), or
3. The underlying HTTP response body closes cleanly.

`TERMINAL_STATES` (exported from `@a2x/sdk`) is the canonical set:

```typescript
import { TERMINAL_STATES } from '@a2x/sdk';
// Set<TaskState>: completed, failed, canceled, rejected (case-insensitive)
```

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

## Error Handling During a Stream

The SDK distinguishes two error paths:

### Non-stream response (wrong content type)

If the server returns `application/json` instead of `text/event-stream` (e.g. because authentication failed and the server shortcuts to a JSON-RPC error), the client parses it and throws the mapped `A2AError`:

```typescript
try {
  for await (const event of client.sendMessageStream(params)) { /* … */ }
} catch (err) {
  if (err instanceof AuthenticationRequiredError) { /* handle */ }
  else if (err instanceof InvalidParamsError) { /* … */ }
  else throw err;
}
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

Format-B servers (JSON-RPC-wrapped SSE) cannot send an `error` event — they surface errors as a non-SSE JSON-RPC error response instead.

### HTTP 401 during streaming

Unlike non-streaming requests, streaming does **not** retry via `authProvider.refresh()`. A 401 on the SSE endpoint throws an `InternalError('HTTP 401: Unauthorized')`. If you need automatic refresh for streaming, wrap your own retry around the generator:

```typescript
async function streamWithRefresh(params: SendMessageParams) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      for await (const event of client.sendMessageStream(params)) yield event;
      return;
    } catch (err) {
      if (attempt === 0 && err instanceof InternalError && /401/.test(err.message)) {
        // We know refresh is safe because this error is from fetch, not protocol
        // Force the provider's refresh path by constructing a dummy 401:
        // (see note below on better patterns)
        continue;
      }
      throw err;
    }
  }
}
```

A cleaner pattern: construct a fresh client on HTTP 401 during streaming, forcing `provide()` to run again.

---

## SSE Wire Formats

The parser handles two formats interoperably — you don't need to know which the server uses:

### Format A: explicit event names (a2x servers)

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

### Format B: data-only with JSON-RPC wrapping (ADK-style servers)

```
data: {"jsonrpc":"2.0","id":1,"result":{"kind":"status-update","taskId":"…","status":{"state":"working"}}}

data: {"jsonrpc":"2.0","id":1,"result":{"kind":"artifact-update","artifact":{"parts":[…]}}}
```

For Format B, the parser:

1. Unwraps the JSON-RPC envelope (takes `result`).
2. Detects event type via the `kind` discriminator or structural cues (`status` + `taskId` without `artifacts` → status-update; `artifact` → artifact-update).
3. Stops when a status event with `final: true` and terminal state arrives.

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
