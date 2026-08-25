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

Per spec a2a-v0.3 §SendStreamingMessageSuccessResponse, every chunk on the wire is a full JSON-RPC success response keyed by the request id:

```
data: {"jsonrpc":"2.0","id":1,"result":{"kind":"status-update", …}}
```

`createSSEStream()` and `DefaultRequestHandler` handle the wrapping for you — your agent code yields the raw event objects (`status-update` / `artifact-update`) as before.

See [Consuming Streams](../client/streaming.md) for the client-side iteration pattern.

## Client disconnect detaches the stream

An SSE connection is a subscription to a Task, not ownership of its execution. When a client disconnects mid-stream — tab closed, network drop, process killed — A2X stops writing to that response but continues consuming the agent's event generator. Task-store persistence, push notifications, and task event-bus publication continue through the interaction-ending or terminal state, and other subscribers remain attached.

A disconnect does not abort `context.signal` or change the Task to `canceled`. To stop the underlying work, send an explicit `tasks/cancel` request. Execution deadlines and process-shutdown policies can also abort work independently of an SSE connection.

`toA2x()` wires detachment and background draining automatically. If you mount the handler into your own HTTP stack (Express, Next.js, Fastify, …), wire a `res.on('close')` → `reader.cancel()` on the SSE branch. `createSSEStream()` then stops response delivery while continuing to drain its source. `IncomingMessage.close` fires when the request body is consumed (too early) and misses the later TCP close, so use `res.close`:

```ts
const stream = createSSEStream(result);
const reader = stream.getReader();

res.on('close', () => {
  void reader.cancel().catch(() => {});
});
```

See [Framework Integration](./framework-integration.md) for the full per-framework recipe.

## Multi-modal output: file and data artifacts

A2A's wire format already supports non-text parts (`FilePart`, `DataPart`) alongside the familiar `TextPart`. A2X surfaces this on the agent side via three `AgentEvent` data variants — agents that extend `BaseAgent` (or are wrapped by `LlmAgent`) can yield any of them and the executor takes care of the artifact mapping.

```ts
import { BaseAgent } from '@a2x/sdk';
import type { AgentEvent } from '@a2x/sdk';

class ImageAgent extends BaseAgent {
  constructor() {
    super({ name: 'image_agent' });
  }

  async *run(): AsyncGenerator<AgentEvent> {
    yield { type: 'text', text: 'Here is your image:', role: 'agent' };
    yield {
      type: 'file',
      file: {
        url: 'https://cdn.example.com/out.png',
        mediaType: 'image/png',
        filename: 'out.png',
      },
      artifact: {
        name: 'out.png',
        description: 'Generated image',
        metadata: { model: 'image-model-v1' },
      },
      deliveryMetadata: { 'example.delivery': 'preview' },
    };
    yield {
      type: 'data',
      data: { score: 0.92, label: 'cat' },
      mediaType: 'application/json',
    };
    yield { type: 'done' };
  }
}
```

How the default `AgentExecutor` maps each event to a `TaskArtifactUpdateEvent`:

| Event | Mapping |
|---|---|
| `text` | Accumulated in one text artifact (`artifact-${taskId}-text`). The first chunk establishes it with `append: false`; later chunks use `append: true`; `done` replaces it with the consolidated value and `lastChunk: true`. Artifact descriptors merge across chunks. |
| `file` | A new artifact (`artifact-${taskId}-file-${n}`) carrying a single `FilePart`. Emitted inline with `append: false`, `lastChunk: true`, plus any artifact descriptor. |
| `data` | A new artifact (`artifact-${taskId}-data-${n}`) carrying a single `DataPart`. Emitted inline with `append: false`, `lastChunk: true`, plus any artifact descriptor. |

The "one logical output = one artifact" mapping matches A2A's intuition and lets clients render each non-text result independently. Mixed runs work as expected: text accumulates into a single artifact, while each `file` / `data` event spawns its own.

`artifact` and `deliveryMetadata` describe different agent intents and have deliberately different lifetimes. The artifact descriptor belongs to the durable logical output: the default A2A executor maps it onto the terminal Artifact returned by both streaming and non-streaming execution and by later `tasks/get` calls. Delivery metadata describes only that occurrence of the content; the A2A executor maps it onto the individual `artifact-update` sent to the primary stream and live resubscribers, without persisting it on the Artifact. The consolidated text update synthesized at completion has no delivery metadata.

For streamed text, `name` and `description` are fixed once provided, `extensions` form an ordered union, and non-conflicting `metadata` keys accumulate. A repeated metadata key must have a deeply equal value. Conflicting descriptor values fail the task instead of silently replacing durable Artifact information.

Every interaction ends with a status update. A yielded `done` produces `completed`, `error` produces `failed`, and a generator that simply returns is treated as completed. Artifacts emitted before failure or an implicit return remain on the task. In v0.3, every status update includes the required top-level `final` field: `false` while work continues and `true` on the interaction-ending status (`completed`, `failed`, or `input-required`). v1.0 omits this legacy field and relies on end-of-stream.

If you need progressive streaming for a single non-text artifact (e.g. chunked image generation), drop down to a custom `AgentExecutor` and emit `TaskArtifactUpdateEvent`s directly with `append: true`. The `AgentEvent` abstraction intentionally stays simple — one event = one artifact.

## Input-required round-trips on streams

Agents can interrupt a streaming run to ask the client for input — most often a payment (`x402RequestPayment`) or an approval. The `request-input` AgentEvent halts the agent and the default `AgentExecutor` emits one final `status-update` carrying state `input-required` plus the agent-supplied wire metadata (e.g. `x402.payment.required`). On v0.3 that event carries `final: true`. The original stream then ends. The client signs the payment (or otherwise satisfies the round-trip), resubmits via `message/stream`, and on the second stream the server emits a fresh sequence:

```
status-update  WORKING
status-update  WORKING + x402.payment.verified   // intermediate emitted by the registered hook
artifact-update text                              // agent runs the paid path
status-update  COMPLETED + x402.payment.completed
```

The hook-driven intermediate event (`payment-verified` for x402) is emitted exactly once per resume — it's not a tick, just a marker between hook completion and the agent's second-turn run. Custom domains that don't supply an `intermediate` outcome simply skip that line.

> **Note on LLM provider responses.** `LlmAgent` propagates whatever `Part` shapes the configured `LlmProvider` returns. The bundled providers (Anthropic, OpenAI, Google) currently only emit text parts from chat-completion responses; non-text parts are most useful today when you implement a custom `BaseAgent` that calls an image-generation or structured-output API directly.

## Resuming a dropped SSE stream

If a client loses connection mid-task, it can re-attach via the A2A `tasks/resubscribe` method without restarting the agent. A2X keeps an in-memory **task event bus** that fans events from the original `message/stream` to every live subscriber; a resubscriber catches the tail of the same execution.

Semantics:

- **Forward-only while active.** Events that fired before a live resubscribe call are not replayed.
- **Interaction-ending replay.** Resubscribing after the current interaction ended yields one status update, then ends. This covers terminal states plus `input-required` and `auth-required`.
- **Disconnected primary streams keep running.** Closing the original HTTP connection does not cancel the Task. A live resubscriber receives subsequent events, and a later resubscribe replays the interaction-ending status.
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
