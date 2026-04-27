---
'@a2x/sdk': patch
---

Fix `PushNotificationAuthenticationInfo` to match the v1.0 spec on the wire. The
SDK previously emitted (and accepted) the v0.3 shape `{ schemes: string[] }` even
on v1.0 transports, which violates `a2a-v1.0.0.json` (`{ scheme: string,
credentials? }`, `additionalProperties: false`). The internal store still keeps
the v0.3 shape; the v1.0 response mapper now collapses `schemes` to `scheme` on
output, and the inbound validator on a v1.0 agent now requires the `scheme`
field and normalizes it back to `[scheme]` for storage. v0.3 agents are
unchanged.
