# Client Basics

`A2XClient` calls any A2A-compliant agent — not just A2X ones — from TypeScript. Give it a URL, call methods, get typed results.

## Create a client

```ts
import { A2XClient } from '@a2x/sdk/client';

const client = new A2XClient('https://agent.example.com/.well-known/agent.json');
```

Pass the AgentCard URL (the `.well-known` path), or a base URL whose well-known paths the resolver should probe. The client fetches and caches the card on first use and uses its declared JSON-RPC interface for subsequent calls. A bare JSON-RPC endpoint is not a supported string input; resolve a card first and pass the card object when discovery is handled elsewhere.

## Custom headers and authentication

Pass static headers through the client options:

```ts
const client = new A2XClient(cardUrl, {
  headers: { 'User-Agent': 'my-service/1.0' },
  authProvider,
});
```

Resolved authentication schemes are applied after custom headers and replace a custom header with the same case-insensitive name. This prevents values such as `authorization` and `Authorization` from being combined by Fetch. Do not use `headers` to compete with a header owned by the selected auth scheme; put that credential in the `AuthProvider` instead.

A custom `AuthScheme.applyToRequest()` still receives the complete built request context, including static and protocol headers, so it can compute request signatures or augment cookies. After each scheme runs, the client collapses any remaining case-variant header names so later schemes and Fetch see one value.

## Send a message

```ts
const task = await client.sendMessage({
  message: {
    messageId: crypto.randomUUID(),
    role: 'user',
    parts: [{ text: 'Summarize the attached log.' }],
  },
});

console.log(task.status.state);           // 'completed'
console.log(task.status.message?.parts);  // agent's reply parts
```

`sendMessage()` is **unary**: it returns one `Task` rather than an event stream. The task is not necessarily terminal—`configuration.blocking`, the peer's behavior, and interrupted states such as `input-required` determine what comes back. Inspect `task.status.state` and poll with `getTask()` when work remains.

The return value is a full `Task` object with status, artifacts, and the agent's final message. See the API reference for the exact shape.

## Get or cancel an existing task

```ts
const existing = await client.getTask('task-abc123');
console.log(existing.status.state);

const canceled = await client.cancelTask('task-abc123');
```

`task-abc123` is the `id` from the task you previously submitted. This is how you poll long-running work or abort something the user changed their mind about.

## Bounding history and registering a webhook in one call

`SendMessageConfiguration` (the optional `configuration` field on `sendMessage()`) follows the v0.3 spec verbatim:

```ts
await client.sendMessage({
  message: {
    messageId: crypto.randomUUID(),
    role: 'user',
    parts: [{ text: 'Hello' }],
  },
  configuration: {
    // Wait for the task to reach a terminal state before resolving.
    // false → return as soon as the agent picks the task up.
    blocking: true,
    // Cap the history slice the server returns on the response Task.
    historyLength: 10,
    // Register a webhook for this task in the same round-trip — no
    // follow-up tasks/pushNotificationConfig/set call needed.
    pushNotificationConfig: {
      id: 'cfg-1',
      url: 'https://my-app.example.com/a2a-webhook',
      token: 'secret',
    },
  },
});
```

`tasks/get` accepts the same `historyLength` (as a top-level param):

```ts
await client.getTask('task-abc123', { historyLength: 1 });
```

## Message parts

`parts` is an array — you can send text plus other modalities:

```ts
await client.sendMessage({
  message: {
    messageId: crypto.randomUUID(),
    role: 'user',
    parts: [
      { text: 'What does this image show?' },
      {
        raw: base64Png,
        mediaType: 'image/png',
      },
    ],
  },
});
```

Whether a particular agent accepts image/file parts depends on its declared
`defaultInputModes` and the selected skill's `inputModes`. Inspect the matching
output-mode fields before assuming a binary response format.

## Handling errors

```ts
try {
  const task = await client.sendMessage({ message });
  if (task.status.state === 'failed') {
    console.error(task.status.message);
  }
} catch (err) {
  // Network or protocol-level error.
}
```

Failed tasks are a normal return path — the agent reports the failure via `task.status.state === 'failed'` and the message explains why. A thrown exception usually means the network or the AgentCard URL itself is broken.

## Next

- [Consuming Streams](./streaming.md) — when you want incremental updates instead of a single blocking call.
- [Agent Card Discovery](./agent-card-discovery.md) — version negotiation, multiple transports, auth introspection.
- [Authentication](../advanced/authentication.md) — client-side auth scheme handling.
