---
"@a2x/sdk": minor
---

Export `TaskEventBus` and `InMemoryTaskEventBus` from the package entry. The `taskEventBus` constructor option on `A2XServer` was already public, but its supporting types were not exported, so callers could not type a custom bus (as the manual-wiring guide showed). They are now importable from `@a2x/sdk`.

Also re-syncs documentation with the current public surface: corrects the `request-input` / resume model in the agent guide (the SDK keeps no cross-turn state — agents read `context.message`), fixes the client error-handling guide (auth failures surface as a `Task` in `auth-required` state, not a removed `AuthenticationRequiredError`; the JSON-RPC error-code table now matches `A2A_ERROR_CODES`), and drops references to non-existent security scheme classes.
