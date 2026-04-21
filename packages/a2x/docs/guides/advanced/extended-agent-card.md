# Authenticated Extended AgentCard

An agent can expose a **richer** AgentCard to authenticated callers — extra skills, a longer description, private documentation URLs — without leaking any of it on the public `/.well-known/agent.json`. This is the A2A v0.3 `agent/getAuthenticatedExtendedCard` method, and A2X implements it as an extension on v1.0 too (the v1.0 spec doesn't bind a JSON-RPC name, so we reuse the v0.3 one).

Use this when:

- A skill is free to advertise publicly but only bookable by paying users.
- Documentation or support URLs shouldn't be harvested by crawlers.
- You want to tailor the card per-principal (enterprise tenant, user plan, role).

## Wiring it up

Register a provider callback that, given the resolved `AuthResult`, returns a partial agent state to merge on top of the base:

```ts
import {
  A2XAgent,
  ApiKeyAuthorization,
  type AuthResult,
  type A2XAgentState,
} from '@a2x/sdk';

const a2xAgent = new A2XAgent({ taskStore, executor })
  .setDefaultUrl('https://agent.example.com/a2a')
  .setName('acme-agent')
  .setDescription('Public description of Acme Agent.')
  // Auth is required — the handler returns AuthenticationRequiredError
  // on unauthenticated calls to the extended-card method.
  .addSecurityScheme('apiKey', new ApiKeyAuthorization({
    in: 'header',
    name: 'x-api-key',
    keys: [process.env.API_KEY!],
  }))
  .addSecurityRequirement({ apiKey: [] })
  .setAuthenticatedExtendedCardProvider(async (auth: AuthResult): Promise<Partial<A2XAgentState>> => {
    return {
      description: 'Full Acme Agent description with private notes.',
      skills: [
        { id: 'public_chat', name: 'Chat', description: 'General Q&A.', tags: ['chat'] },
        { id: 'premium_analysis', name: 'Deep Analysis', description: 'Subscribers only.', tags: ['premium'] },
      ],
      documentationUrl: 'https://internal.example.com/acme-agent/docs',
    };
  });
```

That's it. Calling the builder also flips the advertising capability on the base AgentCard:

- v0.3: `supportsAuthenticatedExtendedCard: true`
- v1.0: `capabilities.extendedAgentCard: true`

Conforming clients see the flag, then call `agent/getAuthenticatedExtendedCard` with valid auth to fetch the enriched card.

## Merge semantics

The partial state returned by your provider is merged over the base state this way:

| Field | Merge strategy |
|---|---|
| Top-level scalars (`name`, `description`, `defaultUrl`, `version`, …) | Overlay replaces. |
| `skills`, `interfaces`, `securityRequirements`, `defaultInputModes`, `defaultOutputModes` | Overlay replaces the whole array when provided. |
| `capabilities` | Deep-merged — missing keys keep base values. |
| `securitySchemes` (Map) | Merged — overlay wins on key collision. |

If you only want to *add* skills rather than replace them, build the merged array yourself from the base state:

```ts
.setAuthenticatedExtendedCardProvider(async (auth) => {
  const base = a2xAgent.getAgentCard();   // current public card
  return {
    skills: [...base.skills, { id: 'premium', ... }],
  };
});
```

## Error semantics

| Situation | JSON-RPC error | Code |
|---|---|---|
| Provider never registered | `AuthenticatedExtendedCardNotConfiguredError` | `-32007` |
| Call arrives without auth (no `context`, failed auth, missing required scope) | `AuthenticationRequiredError` | `-32008` |
| Resolved name / description missing after merge | Internal error (your provider stripped required fields) | `-32603` |

The auth check runs at the `DefaultRequestHandler` level via the normal security-scheme flow — you don't need to re-implement it inside the provider. The provider only runs **after** `AuthResult.authenticated === true`.

## When `AuthResult` has a principal

Most schemes populate `AuthResult.principal` with whatever identity your validator returned (user ID, tenant ID, JWT sub, etc.). That's the hook for per-principal enrichment:

```ts
.setAuthenticatedExtendedCardProvider(async (auth) => {
  const userId = (auth.principal as { sub: string }).sub;
  const plan = await lookupUserPlan(userId);

  return {
    description: `Acme Agent — ${plan} tier.`,
    skills: plan === 'enterprise'
      ? [...publicSkills, ...enterpriseSkills]
      : publicSkills,
  };
});
```

Keep the callback cheap. It runs on every extended-card request, and the SDK does **not** cache the per-principal result (unlike the base card, which is cached by version).
