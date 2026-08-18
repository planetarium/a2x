---
"@a2x/sdk": minor
---

Persist every task transition through the `TaskStore` instead of relying on object identity.

`DefaultRequestHandler` used to let `AgentExecutor` mutate the `Task` object the store had handed out, and never wrote the result back. That only worked because `InMemoryTaskStore` returned its live record: against any durable store — which deserializes or clones on read — `message/send` returned a terminal task with artifacts while `tasks/get` still reported `submitted` with none. The same applied to terminal transitions and artifacts on `message/stream`, and to `tasks/cancel`.

The handler now writes the `working` transition, the blocking result, each streaming status transition (carrying the artifacts accumulated so far), and cancellation through `updateTask()`, so a response and a subsequent `tasks/get` always agree. Artifacts from an earlier turn are no longer dropped when a continuation turn (`input-required` → resume) completes, and `message/send` now returns the artifacts an agent produced before it asked for input — `message/stream` already emitted them. `tasks/cancel` reports `TaskNotCancelableError` instead of a bogus success when the task reaches a different terminal state first.

Cancellation that wins before the blocking `working` write now prevents the agent from running, and a failed streaming terminal write no longer suppresses the best-effort artifact flush or dispatch a non-terminal webhook. Custom executors may return their own successful cancellation state; the handler only reports `TaskNotCancelableError` when the store contains a different state than the executor requested.

Artifact ids are now allocated against what the task already carries instead of from a counter that restarts every turn, so a continuation turn no longer emits an id that silently supersedes an earlier turn's artifact. A task's first turn is unaffected (`artifact-<taskId>-text`, `artifact-<taskId>-data-1`, …); later turns continue the sequence.

`InMemoryTaskStore` returns defensive copies. **If you have a custom request handler or executor that mutates a task obtained from the store and expects that to persist, it no longer does** — such code has to call `updateTask()` explicitly. Nothing warns you: the failure mode is silent divergence, which is exactly why the in-memory store now behaves like a durable one.

Two helpers are exported for custom implementations: `cloneTask()` for snapshotting, and `applyArtifactUpdate()` for folding streamed artifact chunks per the spec's `append` semantics.

When `structuredClone()` cannot copy user metadata, `cloneTask()` now recursively isolates standard task, message, artifact, part, map, and set containers instead of sharing nested objects through its fallback.
