---
"@a2x/sdk": patch
---

Persist every default-handler task transition through `TaskStore.updateTask()`.

Blocking and streaming responses, streamed artifacts, status transitions, and cancellation now agree with a subsequent `tasks/get` when the store returns serialized snapshots. Streamed artifacts are written before delivery, status writes carry their complete artifact set, transient terminal writes are retried during cleanup, and a terminal state that wins a concurrent write is returned as the authoritative stream result.
