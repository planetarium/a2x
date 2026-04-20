---
'@a2x/sdk': minor
---

Emit and consume OAuth2 Device Code flow as a non-standard extension on A2A
v0.3 AgentCards.

Previously, `OAuth2DeviceCodeAuthorization.toV03Schema()` returned `null` and
the scheme was silently stripped from v0.3 cards — headless/CLI clients that
rely on device code flow could not negotiate against v0.3 peers even though
both sides already supported it internally.

The scheme now emits `oauth2.flows.deviceCode` on v0.3 cards (mirroring the
v1.0 shape) and `normalizeOAuth2FlowsV03()` consumes it. OpenAPI 3.0 does
not standardize this flow, so a warning is still logged on emission and
strict third-party v0.3 parsers may ignore the unknown flow.
