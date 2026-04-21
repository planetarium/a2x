---
"@a2x/sdk": patch
---

fix(transport): terminate server-side execution when SSE client disconnects

Previously, when an SSE client disconnected mid-task, the server continued executing the full LLM loop (up to 25 calls) because `createSSEStream`'s cancel callback was empty and the built-in HTTP server never listened for `req.on('close')`. Now the cancel callback calls `.return()` on the source generator, `AgentExecutor`'s finally block aborts its internal controller (which PR #22 already wired through to the LLM provider), and the built-in server cancels the stream reader on TCP close. Closes #20.
