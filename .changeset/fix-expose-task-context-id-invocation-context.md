---
'@a2x/sdk': patch
---

`InvocationContext` now exposes `taskId` and `contextId` so agent code
has a stable per-task identifier to bind durable state to.

Closes [#158](https://github.com/planetarium/a2x/issues/158).

**Why.** The default `AgentExecutor` creates a fresh `Session` on every
invocation (`runner.createSession()` runs on both the first turn and
each resume turn), so `context.session.id` was a per-invocation UUID,
not a per-task one. Agents that stored `task_id = context.session.id`
on the `request-input` turn (e.g. an x402 payment intent row) saw a
different `session.id` on the resume turn and could not recover the
record. The A2A wire protocol's `Task.id` (and `contextId`) was the
right identifier all along, but it wasn't surfaced on the agent's
context.

**What's new.**

- `InvocationContext` gains two optional fields, set by the default
  `AgentExecutor`:
  - `taskId` — the A2A `Task.id`, stable across `request-input` →
    resume turns of the same task.
  - `contextId` — the A2A `contextId`, stable across every task in
    the same conversation (1:N with `taskId`).
- `Runner.runAsync()` accepts an optional fourth `taskScope`
  argument carrying these identifiers. The default `AgentExecutor`
  passes `{ taskId: task.id, contextId: task.contextId ?? task.id }`
  on both `execute()` and `executeStream()` paths.
- Agent authors should bind per-task durable state to
  `context.taskId` (not `context.session.id`). `session.id` keeps its
  existing per-invocation lifecycle and is intentionally unchanged.

**Compatibility.** Additive on every public surface. Existing agents
that read `context.session.id` continue to compile and run; the bug
they hit (re-binding state across resume) is what this change fixes.
Standalone `Runner` callers that don't go through the `AgentExecutor`
leave `taskId` / `contextId` undefined, same as before.
