# Protocol Extensions

A2A accommodates non-standard capabilities via extensions — fields the core spec doesn't mandate but that participants agree on. A2X uses this mechanism to expose features that don't map cleanly onto an older spec version.

## Built-in: OAuth 2.0 Device Code on v0.3

Device Code flow was formalized in A2A v1.0. Many real-world deployments are still on v0.3 cards, but headless clients (CLIs, IoT) need Device Code regardless.

A2X emits `oauth2.flows.deviceCode` on v0.3 cards as a non-standard extension, and `A2XClient` consumes it on the reading side. Both sides need no additional work — declare the scheme once:

```ts
import { OAuth2DeviceCodeAuthorization } from '@a2x/sdk';

a2xAgent
  .addSecurityScheme('deviceCode', new OAuth2DeviceCodeAuthorization({ /* ... */ }))
  .addSecurityRequirement({ deviceCode: [] });
```

And it appears in both v1.0 and v0.3 forms of the card. OpenAPI 3.0 doesn't standardize this flow, so strict third-party v0.3 parsers may ignore the field — in practice, clients that care about Device Code also understand this extension.

You'll see a warning in logs when emitting this on a v0.3 card; it's informational, not a problem.

## Writing your own extension

Extensions live on the AgentCard as additional JSON properties. Pick a namespace you control (a domain you own, a prefix like `x-<team>-`) to avoid collisions.

```ts
const a2xAgent = new A2XAgent({ taskStore, executor })
  .setDefaultUrl('...')
  .setExtension('x-acme-pricing', {
    tier: 'enterprise',
    rateLimit: { rpm: 1000 },
  });
```

Clients that understand the `x-acme-pricing` namespace can read it off the card:

```ts
const resolved = await client.resolveAgentCard();
const pricing = (resolved.card as any)['x-acme-pricing'];
```

A2X treats extension fields opaquely — it copies them through on emission and exposes them on parse. Interpretation is your protocol to write down.

## Versioning extensions

Two techniques are common:

1. **Embed a version in the extension field name**: `x-acme-pricing-v2`. Clean breaks, no backward compat in the field itself.
2. **Embed a version inside the payload**: `{ version: 2, tier: '...' }`. More flexible but requires handling mixed versions.

Use approach (1) for major shape changes, (2) for incremental additions.

## Input-required round-trips for non-payment domains

A2X's `request-input` AgentEvent + `InputRoundTripHook` plumbing was built for x402 payments but is intentionally domain-agnostic. The same machinery works for any extension that needs the merchant agent to ask the client for additional input mid-task — human approvals, OAuth tokens fetched via Device Flow, AP2 mandates, etc.

Pick a domain key you control (e.g. `'myorg.approval'`). The agent yields a `request-input` event with that domain; the executor halts the agent, sets the task to `input-required`, and merges your extension-specific metadata onto the wire status message.

```ts
class SensitiveAgent extends BaseAgent {
  async *run(context) {
    if (!context.input) {
      yield {
        type: 'request-input',
        domain: 'myorg.approval',
        metadata: {
          'myorg.approval.required': { reviewerId: '...', topic: 'delete-customer-data' },
        },
        message: 'Awaiting approval',
        payload: { topic: 'delete-customer-data' },
      };
      return;
    }
    const approved = context.input.resumeMetadata['myorg.approval.granted'] === true;
    if (!approved) {
      yield { type: 'error', error: new Error('declined') };
      return;
    }
    yield { type: 'text', role: 'agent', text: 'Done.' };
    yield { type: 'done' };
  }
}
```

You can register a hook on the executor (`inputRoundTripHooks: [...]`) to centralize verification logic — see how `x402PaymentHook()` does verify+settle in `@a2x/sdk/x402` for the canonical pattern. Or, like the snippet above, inspect `context.input.resumeMetadata` directly when no out-of-band verification is needed. Either way the SDK core stays out of your extension's wire format.

## When not to use extensions

If the thing you're adding will eventually be part of A2A itself, push the proposal to the A2A spec repo instead of locking users into your private extension. Extensions are for:

- Adapting to older spec versions (like Device Code on v0.3).
- Company-specific metadata that won't ever be standardized (pricing, SLA, internal routing hints).
- Experimental features you want to ship before they're ratified.

For everything else, stick to the spec.
