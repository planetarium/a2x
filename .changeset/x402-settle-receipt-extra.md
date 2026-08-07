---
'@a2x/sdk': minor
---

`X402SettleResponse` now carries the facilitator's scheme-specific `extra`.

`BaseX402Context.settle()` built the wire receipt from a fixed field list and
dropped everything else the facilitator returned. That is lossy for any
stateful scheme: `batch-settlement` reports the channel's post-settlement
state in `extra.channelState`, and it is the payer's only way to learn its
voucher was accepted and what the next one must be cumulative over. Without it
a payer re-signs an identical voucher — and re-deposits — on every call.

The block is forwarded verbatim and retained in the durable lifecycle-store
receipt (plain objects only; a scalar or array from a remote facilitator is
dropped rather than typed as a record). Retaining it lets a stateful server
recover after settlement even if it stops before emitting the terminal A2A
event. `exact` and `upto` never populate it, so existing receipts are unchanged.

For a `batch-settlement` receipt, `X402SettleResponse.amount` now reports the
per-call service charge from `extra.chargedAmount`. Upstream's top-level
`amount` names the immediate transfer — empty for an off-chain voucher, the
whole funding total for a deposit payload — so passing it through verbatim
would record either nothing or the deposit as "what this call settled for".
Other schemes keep the facilitator's `amount` unchanged.

Also corrects the documented meaning of `transaction`. It reads "Transaction
hash on success, empty string on failure", but a successful `batch-settlement`
voucher settles off-chain and upstream returns `{ success: true, transaction:
'' }`. An empty `transaction` therefore does not imply failure — branch on
`success`.
