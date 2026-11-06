# Client Basics

`A2XClient` calls any A2A-compliant agent — not just A2X ones — from TypeScript. Give it a URL, call methods, get typed results.

## Create a client

```ts
import { A2XClient } from '@a2x/sdk/client';

const client = new A2XClient('https://agent.example.com/.well-known/agent.json');
```

Resolved authentication schemes are applied after custom headers and replace a custom header with the same case-insensitive name. This prevents values such as `authorization` and `Authorization` from being combined by Fetch. Case variants of `Cookie` are instead joined with the cookie delimiter so unrelated caller cookies survive cookie-based authentication. Do not use `headers` to compete with a header owned by the selected auth scheme; put that credential in the `AuthProvider` instead. Authentication cannot replace operation-owned `Content-Type`, streaming `Accept`, or the active A2A extension header; the client rejects that conflict before transport.

Pass the AgentCard URL (the `.well-known` path), or a base URL whose well-known paths the resolver should probe. The client fetches and caches the card on first use and uses it to select a compatible protocol binding and endpoint.

You can also pass an AgentCard object directly. A URL is always treated as an AgentCard URL or discovery base URL, not as an untyped protocol endpoint.

For v1.0 cards, the client supports `JSONRPC` and `HTTP+JSON`. It prefers JSON-RPC by default when both are advertised. Override the order when you want REST:

```ts
import { A2A_TRANSPORTS, A2XClient } from '@a2x/sdk/client';

const client = new A2XClient('https://agent.example.com', {
  preferredTransports: [
    A2A_TRANSPORTS.HTTP_JSON,
    A2A_TRANSPORTS.JSONRPC,
  ],
});
```

Selection is fail-closed: the client rejects a card that advertises only an uninstalled binding such as `GRPC`, before acquiring credentials or sending a request. v0.3 non-JSON-RPC cards are rejected because the HTTP+JSON adapter implements the v1.0 wire shape only.

When the selected v1.0 interface declares `tenant`, the HTTP+JSON adapter uses the protocol's tenant-prefixed routes, such as `/acme/message:send`; the JSON-RPC adapter keeps `tenant` in the request parameters.

## Send a message

```ts
const task = await client.sendMessage({
  message: {
    role: 'user',
    parts: [{ text: 'Summarize the attached log.' }],
  },
});

console.log(task.status.state);           // 'completed'
console.log(task.status.message?.parts);  // agent's reply parts
```

`sendMessage()` is **unary**: one request, one response. It blocks until the task completes (or fails).

The return value is a full `Task` object with status, artifacts, and the agent's final message. See the API reference for the exact shape.

## Get or cancel an existing task

```ts
const existing = await client.getTask('task-abc123');
console.log(existing.status.state);

const canceled = await client.cancelTask('task-abc123');
```

`task-abc123` is the `id` from the task you previously submitted. This is how you poll long-running work or abort something the user changed their mind about.

A2A v1.0 agents can also expose task listing:

```ts
const page = await client.listTasks({
  contextId: 'conversation-123',
  pageSize: 25,
  includeArtifacts: false,
});
```

Custom task stores opt into this operation by implementing `TaskStore.listTasks()`. `InMemoryTaskStore` implements filtering and pagination out of the box.

## Push notification configurations and extended cards

The same high-level methods work through JSON-RPC and HTTP+JSON:

```ts
const saved = await client.createTaskPushNotificationConfig({
  taskId: task.id,
  pushNotificationConfig: {
    id: 'webhook-1',
    url: 'https://client.example.com/a2a-events',
  },
});

await client.getTaskPushNotificationConfig(task.id, 'webhook-1');
await client.listTaskPushNotificationConfigs(task.id);
await client.deleteTaskPushNotificationConfig(task.id, 'webhook-1');

const extendedCard = await client.getExtendedAgentCard();
```

The extended-card call requires the server to configure an authenticated extended-card provider and the client to satisfy its authentication requirements.

## Bounding history and registering a webhook in one call

`SendMessageConfiguration` (the optional `configuration` field on `sendMessage()`) follows the v0.3 spec verbatim:

```ts
await client.sendMessage({
  message: { role: 'user', parts: [{ text: 'Hello' }] },
  configuration: {
    // Wait for the executor's result (the default when omitted).
    // false → acknowledge a persisted task without waiting for completion.
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

## Accept long-running work and retrieve it later

Set `blocking: false` to receive a Task with its actual `id`, `contextId`, and
accepted status while the agent continues working:

```ts
const accepted = await client.sendMessage({
  message: { role: 'user', parts: [{ text: 'Prepare the asset archive' }] },
  configuration: { blocking: false },
});
if ('id' in accepted) {
  // Keep these IDs across conversational turns. Acceptance is not completion.
  const taskId = accepted.id;
  const contextId = accepted.contextId;
  const current = await client.getTask(taskId);
}
```

Use `getTask()` to retrieve the latest persisted state and artifacts; it does not
submit another message or start another execution. Intermediate output is visible
when the host executor persists it; the default unary executor persists its result
when execution finishes. A completed Task is distinct from having downloaded any
files referenced by its artifacts. An `input-required` or `auth-required` result
requires a continuation message using the Task ID.

The SDK client translates `blocking: false` to A2A v1.0
`configuration.returnImmediately: true` for both JSON-RPC and HTTP+JSON. Raw v0.3
requests use `blocking`; raw v1.0 requests use `returnImmediately`. Omitting the
flag preserves blocking behavior (`returnImmediately` defaults to false in v1.0).

Closing the acknowledgement connection does not cancel accepted work. Use
`cancelTask()` for explicit cancellation. Keep a short HTTP deadline for acceptance
and lookup independently of the agent's execution budget. If the acknowledgement
itself is lost, the caller may not know the Task ID: nonblocking mode does not
provide idempotent submission or make a blind retry safe.

For direct handler integrations, acceptance also snapshots the message and
configuration: reusing or changing the original request object after the call
returns does not change accepted work.

Execution is owned by the running server process. A durable Task store alone does
not resume execution after restart; the deployment must provide its own recovery
and reconciliation policy. See [server lifecycle limits](../agent/streaming.md#nonblocking-unary-requests).

## Message parts

`parts` is an array — you can send text plus other modalities:

```ts
await client.sendMessage({
  message: {
    role: 'user',
    parts: [
      { text: 'What does this image show?' },
      {
        file: {
          mimeType: 'image/png',
          bytes: base64Png,    // or: uri: 'https://…'
        },
      },
    ],
  },
});
```

Whether a particular agent accepts image/file parts depends on its capabilities (check the AgentCard's `inputs`/`outputs` fields).

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
