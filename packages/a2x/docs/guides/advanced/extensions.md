# Protocol Extensions

A2A accommodates non-standard capabilities via extensions — fields the core spec doesn't mandate but that participants agree on. A2X uses this mechanism to expose features that don't map cleanly onto an older spec version.

## Built-in: OAuth 2.0 Device Code on v0.3

Device Code flow was formalized in A2A v1.0. Many real-world deployments are still on v0.3 cards, but headless clients (CLIs, IoT) need Device Code regardless.

A2X emits `oauth2.flows.deviceCode` on v0.3 cards as a non-standard extension, and `A2XClient` consumes it on the reading side. Both sides need no additional work — declare the scheme once:

```ts
import { OAuth2DeviceCodeAuthorization } from '@a2x/sdk';

a2xServer
  .addSecurityScheme('deviceCode', new OAuth2DeviceCodeAuthorization({ /* ... */ }))
  .addSecurityRequirement({ deviceCode: [] });
```

And it appears in both v1.0 and v0.3 forms of the card. OpenAPI 3.0 doesn't standardize this flow, so strict third-party v0.3 parsers may ignore the field — in practice, clients that care about Device Code also understand this extension.

You'll see a warning in logs when emitting this on a v0.3 card; it's informational, not a problem.

## Writing your own extension

Extensions live on the AgentCard as additional JSON properties. Pick a namespace you control (a domain you own, a prefix like `x-<team>-`) to avoid collisions.

```ts
const a2xServer = new A2XServer({ taskStore, executor })
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

### Activation families (a2x-specific relaxation)

During a migration between wire generations, a2x lets one capability be advertised under more than one URI. The canonical (generation-neutral) x402 URI is advertised as required, and the legacy v0.2 URI as an optional V1 pin:

```ts
server
  .addExtension({ uri: X402_FOUNDATION_EXTENSION_URI, required: true })  // canonical x402
  .addExtension({ uri: X402_EXTENSION_URI, required: false });   // legacy v0.2 (V1 pin)
```

a2x's request handler treats the x402 URIs as an **activation family**: activating *any* member satisfies the required x402 extension. This is an **a2x-server-specific relaxation** of A2A's per-extension `required` rule — a non-a2x server enforces `required` per URI. It exists so a legacy `a2a-x402 v0.2` client (which activates only the v0.2 URI) still passes an agent that requires the canonical URI.

Generation is **not** selected by which URI is activated (the canonical URI is generation-neutral — see [x402 Payments](./x402-payments.md#protocol-generations-v1--v2)); only the legacy v0.2 URI, activated on its own, pins V1. Read the activated set inside the agent from `context.activatedExtensions` (see [Manual Wiring](./manual-wiring.md#reading-activated-extensions)).

## Input-required round-trips for non-payment domains

A2X's `request-input` AgentEvent is intentionally domain-agnostic. The agent uses it for any extension that needs the merchant to ask the client for additional input mid-task — human approvals, OAuth tokens fetched via Device Flow, AP2 mandates, etc.

The agent yields `request-input` with extension-specific metadata; the executor halts the agent, sets the task to `input-required`, and merges the metadata onto the wire status message. The SDK does not record any cross-turn state — the agent detects whether it's a fresh request or a resume by inspecting `context.message.metadata` itself.

```ts
class SensitiveAgent extends BaseAgent {
  async *run(context) {
    const meta = context.message?.metadata as
      | { 'myorg.approval.granted'?: boolean }
      | undefined;

    // Resume turn: client either granted or did not.
    if (meta) {
      if (meta['myorg.approval.granted'] !== true) {
        yield { type: 'error', error: new Error('declined') };
        return;
      }
      yield { type: 'text', role: 'agent', text: 'Done.' };
      yield { type: 'done' };
      return;
    }

    // First turn: request input.
    yield {
      type: 'request-input',
      metadata: {
        'myorg.approval.required': { reviewerId: '...', topic: 'delete-customer-data' },
      },
      message: 'Awaiting approval',
    };
  }
}
```

If your extension needs to keep "what was asked for" across turns (e.g. the merchant offered specific options and needs to validate the response against them), persist that state yourself in a store keyed by `context.taskId`. The merchant always knows what its extension asks for — the SDK has no useful opinion to add.

The x402 module (`@a2x/sdk/x402`) is the canonical example of this pattern at scale — see `samples/nextjs-x402/src/lib/a2x-setup.ts` for a full implementation.

## When not to use extensions

If the thing you're adding will eventually be part of A2A itself, push the proposal to the A2A spec repo instead of locking users into your private extension. Extensions are for:

- Adapting to older spec versions (like Device Code on v0.3).
- Company-specific metadata that won't ever be standardized (pricing, SLA, internal routing hints).
- Experimental features you want to ship before they're ratified.

For everything else, stick to the spec.
