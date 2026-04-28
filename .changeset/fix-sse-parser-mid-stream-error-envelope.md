---
'@a2x/sdk': patch
---

The SSE stream parser now surfaces mid-stream JSON-RPC error envelopes
as thrown errors instead of silently dropping them.

Closes [#142](https://github.com/planetarium/a2x/issues/142) (fix 5 of 5).

**Why.** When a server-side handler threw mid-stream,
`DefaultRequestHandler._wrapStreamInJsonRpc` yielded a single JSON-RPC
error envelope (`{ jsonrpc, id, error: { code, message, data? } }`)
before closing the connection — exactly as the streaming guide already
documents. But `parseSSEStream`'s `unwrapData` only unwrapped `result`;
the `error` envelope was classified as a generic `MESSAGE` event, and
the switch in `parseSSEStream` had no `MESSAGE` arm, so the chunk was
dropped without ever being yielded or thrown. Clients saw the stream
end as though the task had completed silently.

**Fix.** `unwrapData` now detects a JSON-RPC error envelope and throws
an `Error` with the server's `message` and `code`. The thrown error
propagates out of `parseSSEStream`, terminating the iterator with a
meaningful message — matching what the streaming guide already
promises.
