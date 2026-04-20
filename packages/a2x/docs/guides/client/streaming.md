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
