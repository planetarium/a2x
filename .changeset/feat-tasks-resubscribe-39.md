---
"@a2x/sdk": minor
---

feat(transport): implement `tasks/resubscribe` JSON-RPC method

Adds support for the v0.3 `tasks/resubscribe` method so clients that lose
an SSE connection mid-task can resume the stream without re-executing
the agent. Introduces an in-memory `TaskEventBus` (pluggable via
`A2XAgentOptions.taskEventBus`) that fans events out from `message/stream`
to any number of resubscribers. Resubscribing to a task in terminal state
replays a single status-update event with the final state and ends; for
an unknown task the method returns `TaskNotFoundError`. Closes #39.
