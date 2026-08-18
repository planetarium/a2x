---
"@a2x/sdk": major
---

Make `TaskStore` values true snapshots across in-memory and durable implementations.

`InMemoryTaskStore` now returns defensive copies from every method, matching stores that serialize tasks through Redis or a database. Mutating a returned task no longer changes stored state; custom handlers and executors must persist every transition with `updateTask()`.

This is a breaking correction for custom code that relied on `InMemoryTaskStore` handing out its live object reference. That code must call `updateTask()` explicitly.

Two helpers are exported for custom implementations: `cloneTask()` for snapshotting, and `applyArtifactUpdate()` for folding streamed artifact chunks according to `append` semantics. When `structuredClone()` cannot copy user metadata, `cloneTask()` recursively isolates standard task, message, artifact, part, map, and set containers while retaining only non-cloneable exotic leaves.
