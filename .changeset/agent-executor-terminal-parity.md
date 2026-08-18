---
"@a2x/sdk": patch
---

Preserve artifacts across every `AgentExecutor` terminal path.

Blocking and streaming execution now retain text, file, and data artifacts produced before an error. An agent generator that returns without yielding `done` is finalized as completed on both transports, including a terminal streaming status, instead of leaving a durable streaming task stuck in `working`. Session-creation failures likewise become persisted failed tasks rather than stranding the last pre-execution state.
