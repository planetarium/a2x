---
"@a2x/sdk": minor
---

feat(a2x): implement `agent/getAuthenticatedExtendedCard` JSON-RPC method

Adds a builder API `A2XAgent.setAuthenticatedExtendedCardProvider(fn)` that
lets agent authors declare how to enrich the AgentCard for authenticated
callers. When set, the SDK automatically advertises the capability on the
base card (`supportsAuthenticatedExtendedCard` for v0.3,
`capabilities.extendedAgentCard` for v1.0) and the new JSON-RPC method
returns a merged card built from the base state plus the provider's overlay.
Returns `AuthenticationRequiredError` when the call is unauthenticated and
`AuthenticatedExtendedCardNotConfiguredError` when no provider is
registered.

Also corrects the method-name constant in `A2A_METHODS.GET_EXTENDED_CARD`
from the non-compliant `'agent/authenticatedExtendedCard'` to the
spec-defined `'agent/getAuthenticatedExtendedCard'`. This was never a
functional method before, so no external callers are affected.

Closes #40.
