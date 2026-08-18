---
"@a2x/sdk": minor
---

Persist every task transition through the `TaskStore` instead of relying on object identity.

`DefaultRequestHandler` used to let `AgentExecutor` mutate the `Task` object the store had handed out, and never wrote the result back. That only worked because `InMemoryTaskStore` returned its live record: against any durable store — which deserializes or clones on read — `message/send` returned a terminal task with artifacts while `tasks/get` still reported `submitted` with none. The same applied to terminal transitions and artifacts on `message/stream`, and to `tasks/cancel`.

The handler now writes the blocking result, each streaming status transition (carrying the artifacts accumulated so far), and cancellation through `updateTask()`, so a response and a subsequent `tasks/get` always agree. `InMemoryTaskStore` returns defensive copies, so custom handlers and stores that depend on reference mutation now fail in development rather than only in production.

Two helpers are exported for custom implementations: `cloneTask()` for snapshotting, and `applyArtifactUpdate()` for folding streamed artifact chunks per the spec's `append` semantics.
