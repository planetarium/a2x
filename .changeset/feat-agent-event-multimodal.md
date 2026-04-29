---
'@a2x/sdk': minor
---

`AgentEvent` now supports `file` and `data` variants alongside `text`, so
multi-modal agents (image generation, structured output, document creation,
…) can stay on the `BaseAgent` path without dropping to a custom
`AgentExecutor`.

Closes [#148](https://github.com/planetarium/a2x/issues/148).

**Why.** A2A v0.3 already defines first-class non-text part shapes
(`FilePart`, `DataPart`) and the SDK's internal `Part` union has matched
that since day one. But `AgentEvent` — the contract between agent code
and the runner/executor — only had a `text` data variant, so non-text
output had no expression on the `BaseAgent` path: the default
`AgentExecutor.executeStream` translated `text` into artifact text-parts
and silently dropped everything else. The only workaround was to abandon
`BaseAgent` and emit raw `TaskArtifactUpdateEvent`s from a custom
`AgentExecutor`, which leaks A2A protocol details into agent code.

**What's new.**

- `AgentEvent` adds `{ type: 'file', file: {...} }` and
  `{ type: 'data', data, mediaType? }` variants. The `text` variant gains
  an optional `mediaType` field for distinguishing `text/markdown`,
  `application/json`, etc.
- The default `AgentExecutor` (both `execute()` and `executeStream()`)
  maps each non-text event to a fresh artifact: `file` → `FilePart`
  artifact, `data` → `DataPart` artifact, each with a unique
  `artifactId`. Text events keep their existing accumulation behavior
  (single text artifact per task, append-mode chunks during streaming).
- `LlmAgent.run()` no longer filters non-text parts out of the LLM
  response — they are yielded as `file` / `data` events. (The bundled
  Anthropic / OpenAI / Google provider converters today only emit text
  blocks from chat-completion responses; non-text output mostly applies
  to custom `BaseAgent` implementations.)

**Compatibility.** Additive on the wire: clients receive standard A2A
v0.3 `FilePart` / `DataPart` artifacts, which `A2XClient` and its
response parser already supported. Existing text-only agents and
clients continue to work unchanged.

`switch (event.type) { … }` blocks over `AgentEvent` without a
`default:` branch will need new `case 'file'` / `case 'data'` arms (or
a `default:`) under TypeScript's strict-exhaustiveness checks.
