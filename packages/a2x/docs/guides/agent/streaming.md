# Streaming Responses

A2A defines two transport modes: **unary** (`message/send` — one request, one response) and **streaming** (`message/stream` — Server-Sent Events with incremental updates). A2X supports both and picks the right one automatically based on the client's request.

## When to enable streaming

Enable SSE when any of these apply:

- Your agent's responses are long enough that users would feel a "typing" pause.
- You want to show intermediate tool-call events ("thinking…", "searching…").
- You're orchestrating multi-agent pipelines and want to surface progress.

Skip it when responses are short and latency-insensitive — the unary path is simpler to reason about.

## Server side: already on by default

If you're using `toA2x()`, streaming is already wired up. The short version:

```ts
toA2x(agent, { port: 4000, defaultUrl: 'http://localhost:4000/a2a' });
```

The AgentCard emitted at `/.well-known/agent.json` advertises `capabilities.streaming: true`, and the `POST /a2a` endpoint serves SSE for `message/stream` requests.

If you're wiring manually (see [Framework Integration](./framework-integration.md)), the key piece is:

```ts
import { AgentExecutor, StreamingMode } from '@a2x/sdk';

const executor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
});
```

`StreamingMode.SSE` lets the runner emit incremental events. The rest is automatic.

## What the client actually receives

For a `message/stream` call, the client gets an SSE stream of typed events. Each event is one of:

| Event | Meaning |
|---|---|
| `task` | Initial snapshot of the task, created server-side. |
| `status-update` | Task state transition (`submitted` → `working` → `completed`/`failed`/`canceled`). |
| `artifact-update` | A chunk of output (message parts, tool calls, tool results). |

See [Consuming Streams](../client/streaming.md) for the client-side iteration pattern.

## Client disconnect stops the work

When an SSE client disconnects mid-stream — tab closed, network drop, process killed — A2X propagates the cancellation all the way into the agent's `AbortSignal`. In-flight LLM calls are aborted, long-running tool calls see `context.signal.aborted === true`, and the task generator exits cleanly. No runaway loops, no wasted tokens.

`toA2x()` wires this automatically. If you mount the handler into your own HTTP stack (Express, Next.js, Fastify, …), wire a `res.on('close')` → `reader.cancel()` on the SSE branch — `IncomingMessage.close` fires when the request body is consumed (too early) and misses the later TCP close, so use `res.close`:

```ts
const stream = createSSEStream(result);
const reader = stream.getReader();

res.on('close', () => {
  void reader.cancel().catch(() => {});
});
```

See [Framework Integration](./framework-integration.md) for the full per-framework recipe.

## Resuming a dropped SSE stream

If a client loses connection mid-task, it can re-attach via the A2A `tasks/resubscribe` method without restarting the agent. A2X keeps an in-memory **task event bus** that fans events from the original `message/stream` to every live subscriber; a resubscriber catches the tail of the same execution.

Semantics:

- **Forward-only.** Events that fired before the resubscribe call are not replayed.
- **Terminal replay.** Resubscribing to a task that already completed yields a single status-update event with the final state, then ends.
- **Unknown task.** Returns `TaskNotFoundError` (JSON-RPC error code `-32001`).

The bus is on by default. For custom storage or multi-process deployments you can inject your own implementation — see [Manual Wiring](../advanced/manual-wiring.md#task-event-bus).

## Disabling streaming

If you want a deliberately non-streaming agent (e.g. for backpressure reasons), drop `streamingMode`:

```ts
const executor = new AgentExecutor({ runner, runConfig: {} });
```

The server will still accept `message/stream` requests, but responses come as single-chunk streams. Most clients handle this correctly.

## Debugging SSE

SSE is plain text over HTTP. `curl` works:

```bash
curl -N \
  -H 'Accept: text/event-stream' \
  -H 'Content-Type: application/json' \
  -X POST http://localhost:4000/a2a \
  -d '{
    "jsonrpc": "2.0",
    "id": "1",
    "method": "message/stream",
    "params": { "message": { "role": "user", "parts": [{ "text": "Hi" }] } }
  }'
```

The `-N` flag disables `curl`'s output buffering so you see events as they arrive.
