# Consuming Streams

For responses you want incrementally — token-by-token output, progress events, long-running pipelines — use `sendMessageStream()`.

## The basic loop

```ts
import { A2XClient } from '@a2x/sdk/client';

const client = new A2XClient('https://agent.example.com/.well-known/agent.json');

for await (const event of client.sendMessageStream({
  message: {
    role: 'user',
    parts: [{ text: 'Write a short story about a robot.' }],
  },
})) {
  console.log(event);
}
```

`sendMessageStream()` returns an `AsyncIterable` of typed events. The for-await loop surfaces them as they arrive.

## Event types

Each yielded event is one of:

| Kind | What it tells you |
|---|---|
| `task` | Initial task snapshot — you now have the `task.id`. |
| `status-update` | State transition: `submitted` → `working` → `completed` / `failed` / `canceled`. |
| `artifact-update` | A chunk of output — text fragments, tool calls, tool results. |

Narrow by checking the event shape:

```ts
for await (const event of stream) {
  if ('kind' in event && event.kind === 'status-update') {
    console.log('state:', event.status.state);
  } else if ('kind' in event && event.kind === 'artifact-update') {
    for (const part of event.artifact.parts) {
      if ('text' in part) process.stdout.write(part.text);
    }
  }
}
```

Check `client` types in the API reference for the exact discriminated union.

## Stopping early

Break out of the loop whenever you want — the underlying connection is closed automatically:

```ts
for await (const event of stream) {
  if (userClickedCancel) break;
  render(event);
}
```

If you want the agent itself to stop doing work (not just your client to stop listening), call `client.cancelTask(taskId)` using the `id` from the first `task` event.

Breaking out of the loop is enough on its own: when the underlying HTTP connection closes the server aborts the in-flight agent execution and records the task as `canceled`. You don't need to call `cancelTask` just to save tokens on abandoned streams.

## Resuming a dropped stream

Use the A2A `tasks/resubscribe` method to attach another consumer while the original task stream is still active. If the original HTTP reader has already been canceled, the server aborts that execution and resubscribe returns its persisted `canceled` state rather than restarting it.

Use `subscribeTask()` to reattach through whichever binding the client selected. Both JSON-RPC and HTTP+JSON deliver the response as SSE:

```ts
for await (const event of client.subscribeTask(taskId)) {
  render(event);
}
```

Behavior to know:

- **Forward-only while active.** Events that fired before a live resubscribe call are not replayed — you see what the server publishes from that point on.
- **Interaction-ending replay.** If the interaction already ended, you receive one `status-update`, then the stream ends. This includes terminal states plus `input-required` and `auth-required`.
- **Disconnected primary streams are canceled.** After the original reader closes, resubscribe returns `canceled`; it cannot resume the aborted agent invocation.
- **Unknown task.** The stream ends with the binding-specific error envelope: JSON-RPC error for `JSONRPC`, or `google.rpc.Status` JSON for `HTTP+JSON`.

### SSE wire shape

JSON-RPC SSE chunks are full JSON-RPC success responses, keyed by the original request id:

```
data: {"jsonrpc":"2.0","id":1,"result":{"kind":"status-update","taskId":"…","status":{"state":"working"}}}

data: {"jsonrpc":"2.0","id":1,"result":{"kind":"artifact-update","taskId":"…","artifact":{ … }}}
```

There is no `event:` field, no `event: done` terminator. Stream end is signalled by the server closing the connection after a terminal status (`final: true` in v0.3, or simply the last yielded event in v1.0). Servers from before this release may still emit the legacy `event: status_update`/`event: done` shape; the SDK parser keeps tolerating it for one minor and logs a one-time deprecation warning when it sees it.

HTTP+JSON uses the same `data:`-only SSE framing, with the v1.0 `StreamResponse` oneof wrapper:

```
data: {"task":{"id":"…","status":{"state":"TASK_STATE_SUBMITTED"}}}

data: {"statusUpdate":{"taskId":"…","status":{"state":"TASK_STATE_WORKING"}}}
```

## Accumulating output

A common pattern — render text as it arrives, keep a running buffer:

```ts
let fullText = '';

for await (const event of stream) {
  if ('kind' in event && event.kind === 'artifact-update') {
    for (const part of event.artifact.parts) {
      if ('text' in part) {
        fullText += part.text;
        updateUI(fullText);
      }
    }
  }
}
```

## Error handling

Errors surface as either a `status-update` with `state: 'failed'`, or as a thrown exception from the iterator (for network/protocol failures). Wrap the loop in `try/catch`:

```ts
try {
  for await (const event of client.sendMessageStream({ message })) {
    handle(event);
  }
} catch (err) {
  console.error('stream broken', err);
}
```

## When streaming is not available

Some A2A agents don't advertise `capabilities.streaming`. `A2XClient` handles this transparently — it falls back to `sendMessage()` and yields a single synthetic event sequence. Your code doesn't change.
