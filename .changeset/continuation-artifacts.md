---
"@a2x/sdk": patch
---

Preserve artifacts across input-required continuation turns.

Blocking input requests now retain artifacts just like streaming requests, later turns merge rather than erase earlier artifacts, and artifact ids are allocated against the task's existing ids so resumed output cannot silently replace prior output.
