---
'@a2x/sdk': minor
---

Export the `isEvmNetwork` and `isCaip2EvmNetwork` network-eligibility predicates from `@a2x/sdk/x402`. These are the tests the default requirement selector applies to `exact` and to the V2-only schemes (`upto`, `batch-settlement`) respectively, exported so pre-flight UX — such as the CLI's `--allow-upto` consent hint — can classify a merchant's offers exactly the way the selector will instead of re-deriving the criteria.
