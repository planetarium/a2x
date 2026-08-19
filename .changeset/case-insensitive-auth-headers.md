---
"@a2x/sdk": patch
---

Apply client authentication headers case-insensitively so caller-provided case variants cannot be combined with resolved credentials, preserve every caller Cookie variant, and reject attempts to overwrite transport-owned headers before sending.
