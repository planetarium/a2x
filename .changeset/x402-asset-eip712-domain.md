---
"@a2x/sdk": patch
---

x402: default the EIP-712 `extra` domain per asset instead of always `{name:'USDC'}`.

`@x402/evm` builds the EIP-3009 signing domain from the requirement's `extra.name`/`extra.version`, so an offering that omits `extra` relied on the SDK default — which was hard-coded to `{ name: 'USDC', version: '2' }`, correct only for Base Sepolia USDC. On Base mainnet USDC the EIP-712 domain name is `"USD Coin"`, so the wrong default produced signatures the facilitator could never verify. The default is now keyed by the asset contract for the well-known USDC deployments (Base mainnet + Base Sepolia); other tokens fall back to the previous default and should supply their own `extra`.
