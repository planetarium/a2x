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

As of A2X **0.5.0**, breaking out of the loop is enough on its own: when the underlying HTTP connection closes the server aborts the in-flight agent execution. You don't need to call `cancelTask` just to save tokens on abandoned streams.

## Resuming a dropped stream

If the connection drops but you still want the results — flaky network, mobile tab restore, proxy idle timeout — re-attach to the same task with the A2A `tasks/resubscribe` method. The server keeps publishing events to any live subscriber, so a resubscriber catches the tail of the original execution.

`A2XClient` doesn't yet expose a convenience helper, so issue the call at the JSON-RPC level. The response is an SSE stream with the same event shape as `message/stream`:

```ts
async function resubscribe(url: string, taskId: string) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tasks/resubscribe',
      params: { id: taskId },
    }),
  });

  // Parse the SSE body however you like — reuse your own SSE parser,
  // or the one the A2X transport layer exports if you prefer.
  return response.body!.getReader();
}
```

Behavior to know:

- **Forward-only.** Events that fired before the resubscribe call are not replayed — you see what the server publishes from that point on.
- **Terminal replay.** If the task already completed, you receive a single `status-update` event with the final state, then the stream ends.
- **Unknown task.** The server emits an SSE `error` event carrying `TaskNotFoundError` (JSON-RPC code `-32001`).

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
