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
