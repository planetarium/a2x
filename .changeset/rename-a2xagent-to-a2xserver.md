---
"@a2x/sdk": minor
---

Rename `A2XAgent` to `A2XServer`. The class is the A2A protocol *server* wrapper (task store, executor, AgentCard builder), not an agent — the old name collided with `LlmAgent` and suggested that tools/skills belonged on it. `A2XServerOptions` replaces `A2XAgentOptions`, and `toA2x()` now returns `a2xServer` on its result.

Backward compatible: `A2XAgent`, `A2XAgentOptions`, and `ToA2xResult.a2xAgent` remain as `@deprecated` aliases of the new names and will be removed in a future major. `A2XAgentSkill` and `A2XAgentState` (AgentCard types) are unchanged.
