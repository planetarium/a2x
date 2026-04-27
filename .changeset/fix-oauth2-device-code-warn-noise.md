---
'@a2x/sdk': patch
---

Stop logging a `console.warn` from
`OAuth2DeviceCodeAuthorization.toV03Schema()`. The warning fired on every v0.3
AgentCard render — i.e. on every `GET /.well-known/agent.json?version=0.3` and
every `agent/getAuthenticatedExtendedCard` call — even though emitting Device
Code as a non-standard `oauth2.flows.deviceCode` extension is the SDK's
intentional behavior. The non-standard nature is already documented on the
method's JSDoc and in the authentication guide; the per-render log was pure
noise.
