---
'@a2x/sdk': patch
---

Wrap each SSE chunk in a JSON-RPC success envelope keyed by the originating
request id, per spec a2a-v0.3 §`SendStreamingMessageSuccessResponse`. The
previous wire shape (`event: status_update` / `event: artifact_update` framing
plus a non-spec `event: done` terminator) was interop-broken with any
non-a2x peer (Python ADK, official samples, third-party gateways) — it
worked only because the a2x client parser tolerated both formats.

Closes [#118](https://github.com/planetarium/a2x/issues/118).

**Wire shape — before:**

```
event: status_update
data: {"taskId":"...","status":{...}}

event: done
```

**Wire shape — after:**

```
data: {"jsonrpc":"2.0","id":<request-id>,"result":{"taskId":"...","status":{...}}}
```

Stream end is signalled by connection close after the terminal status
(`final: true` in v0.3); the non-spec `event: done` chunk is gone.

**Changes.**

- `DefaultRequestHandler.handle()` now wraps the streaming generator in
  JSON-RPC envelopes (`_wrapStreamInJsonRpc`) for both the routed stream
  methods and the auth-required stream synthesis. Mid-stream errors yield a
  single trailing JSON-RPC error envelope instead of throwing, so clients
  keyed on the request id can correlate the failure.
- `createSSEStream()` is now a generic `data:`-only encoder — drops the
  `event:` field and the trailing `event: done` terminator.
- The client SSE parser keeps tolerating the legacy framed shape for one
  minor for upgrade compatibility, but emits a one-time deprecation warning
  when it sees it. **The legacy path will be removed in the next minor.**

Tests, fixtures, and the streaming guides are updated to consume the new
shape.
