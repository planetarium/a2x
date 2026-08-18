---
"@a2x/sdk": patch
---

Keep stream cancellation and persisted task state consistent.

Cancellation no longer lets an aborted stream synthesize `completed`, cancellation during session creation no longer enters agent code, and every concurrent in-process execution for the task receives the abort. Disconnecting the primary stream records `canceled` instead of leaving a `working` task that cannot be resubscribed, while resubscribe immediately replays interaction-ending `input-required` and `auth-required` states. Custom cancellation implementations must return a terminal state to report success.
