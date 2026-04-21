---
"@a2x/sdk": patch
---

docs: cover SSE disconnect handling, `tasks/resubscribe`, and the authenticated extended card

Extends the bundled guides to reflect the features landed in PRs #42, #43, #44:

- `guides/agent/streaming.md` — new "Client disconnect stops the work" and "Resuming a dropped SSE stream" sections, with guidance on wiring `res.on('close')` when hand-rolling an HTTP handler.
- `guides/client/streaming.md` — new "Resuming a dropped stream" section showing the raw-JSON-RPC `tasks/resubscribe` pattern plus a note on the new cancel-on-disconnect contract.
- `guides/advanced/manual-wiring.md` — documents `A2XAgentOptions.taskEventBus` with a sketch of a cross-process custom bus.
- `guides/advanced/extended-agent-card.md` — **new** page covering `setAuthenticatedExtendedCardProvider`, overlay merge semantics, per-principal enrichment, and the `-32007` / `-32008` error codes. Linked from `authentication.md`, `agent-card-versioning.md`, and `manifest.json`.
- `guides/agent/framework-integration.md` — Express snippet updated to include the `res.on('close')` disconnect wiring.

Closes #46.
