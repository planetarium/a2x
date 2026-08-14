---
'@a2x/sdk': minor
---

Add `upto` payer RPC configuration to `A2XClientX402Options` and `SignX402PaymentOptions`. Passing `upto: { rpcUrl }` (or a per-chain-id map) lets the `upto` scheme read the signer's Permit2 allowance and EIP-2612 permit nonce, so it can produce the gas-sponsored approval payloads (`eip2612GasSponsoring` / `erc20ApprovalGasSponsoring`) a merchant may advertise. Previously the `UptoEvmScheme` was constructed without any RPC configuration, so those extension payloads were always skipped and merchants requiring a Permit2 allowance rejected the payment with `permit2_allowance_required` (#225).
