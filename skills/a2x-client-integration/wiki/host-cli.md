# Host: Node.js CLI (Interactive)

The `a2x` CLI in this repo is the canonical reference. This page distils it into a drop-in starting point for any interactive Node.js CLI that calls remote A2A agents.

Source to crib from: `packages/cli/src/cli-auth-provider.ts`, `packages/cli/src/token-store.ts`, `packages/cli/src/format.ts`, `packages/cli/src/commands/a2a/*.ts`.

---

## Module Layout

```
src/
├── cli-auth-provider.ts   # AuthProvider with full fallback chain
├── token-store.ts         # File-based credential persistence
├── device-code.ts         # OAuth2 device-code polling loop
└── commands/
    ├── send.ts            # a2a send <url> <message>
    ├── stream.ts          # a2a stream <url> <message>
    └── …
```

---

## `token-store.ts`

See [token-persistence.md](./token-persistence.md) for the full implementation.

Key API:

```typescript
export interface StoredCredential {
  slot: string;
  credential: string;
}
export function credentialSlot(groupIndex: number, schemeIndex: number, scheme: AuthScheme): string;
export function extractCredential(slot: string, scheme: AuthScheme): StoredCredential;
export function credentialPolicyKey(cardUrl: string, endpoint: string, identityPolicyId: string): string;
export function loadCredentials(policyKey: string): StoredCredential[] | undefined;
export function saveCredentials(policyKey: string, credentials: StoredCredential[]): void;
export function clearCredentials(policyKey: string): void;
```

File path: `path.join(os.homedir(), '.<your-cli-name>', 'tokens.json')`.

---

## `device-code.ts`

See [oauth2-device-code.md](./oauth2-device-code.md). Exports:

```typescript
export async function performDeviceCodeFlow(
  scheme: OAuth2DeviceCodeAuthScheme,
  clientId: string,
): Promise<{ access_token: string; refresh_token?: string; expires_in?: number }>;
```

---

## `cli-auth-provider.ts` — Full Chain

See [auth-fallback-chain.md](./auth-fallback-chain.md) for the complete reference. The shortest integration:

Install the masked prompt dependency first: `npm install @inquirer/prompts`.

```typescript
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import { password } from '@inquirer/prompts';
import type { AuthProvider } from '@a2x/sdk/client';
import {
  AuthScheme,
  ApiKeyAuthScheme,
  HttpBearerAuthScheme,
  HttpBasicAuthScheme,
  OAuth2DeviceCodeAuthScheme,
  OAuth2AuthorizationCodeAuthScheme,
  OAuth2ClientCredentialsAuthScheme,
  OAuth2ImplicitAuthScheme,
  OAuth2PasswordAuthScheme,
  OpenIdConnectAuthScheme,
} from '@a2x/sdk/client';
import {
  clearCredentials,
  credentialSlot,
  extractCredential,
  loadCredentials,
  saveCredentials,
} from './token-store.js';
import { performDeviceCodeFlow } from './device-code.js';

async function prompt(q: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
}

async function promptSecret(message: string): Promise<string> {
  return (await password({ message, mask: '*' })).trim();
}

function schemeLabel(scheme: AuthScheme): string {
  if (scheme instanceof ApiKeyAuthScheme) return `API Key (${scheme.params.name})`;
  if (scheme instanceof HttpBearerAuthScheme) return 'Bearer Token';
  if (scheme instanceof HttpBasicAuthScheme) return 'Basic Auth';
  if (scheme instanceof OAuth2DeviceCodeAuthScheme) return 'OAuth2 Device Code';
  if (scheme instanceof OAuth2AuthorizationCodeAuthScheme) return 'OAuth2 Authorization Code';
  if (scheme instanceof OAuth2ClientCredentialsAuthScheme) return 'OAuth2 Client Credentials';
  if (scheme instanceof OAuth2ImplicitAuthScheme) return 'OAuth2 Implicit';
  if (scheme instanceof OAuth2PasswordAuthScheme) return 'OAuth2 Password';
  if (scheme instanceof OpenIdConnectAuthScheme) return 'OpenID Connect';
  return 'Unknown';
}

async function resolveScheme(scheme: AuthScheme): Promise<void> {
  if (scheme instanceof ApiKeyAuthScheme) {
    const key = await promptSecret(`Enter API key (${scheme.params.name})`);
    if (!key) throw new Error('No API key provided');
    scheme.setCredential(key); return;
  }
  if (scheme instanceof HttpBearerAuthScheme) {
    const token = await promptSecret('Enter Bearer token');
    if (!token) throw new Error('No token provided');
    scheme.setCredential(token); return;
  }
  if (scheme instanceof HttpBasicAuthScheme) {
    const cred = await promptSecret('Enter Basic credentials (base64)');
    if (!cred) throw new Error('No credentials provided');
    scheme.setCredential(cred); return;
  }
  if (scheme instanceof OAuth2DeviceCodeAuthScheme) {
    const tokens = await performDeviceCodeFlow(scheme, process.env.OAUTH_CLIENT_ID!);
    scheme.setCredential(tokens.access_token); return;
  }
  if (
    scheme instanceof OAuth2AuthorizationCodeAuthScheme ||
    scheme instanceof OAuth2ClientCredentialsAuthScheme ||
    scheme instanceof OAuth2ImplicitAuthScheme ||
    scheme instanceof OAuth2PasswordAuthScheme
  ) {
    const token = await promptSecret('Enter access token');
    if (!token) throw new Error('No token provided');
    scheme.setCredential(token); return;
  }
  if (scheme instanceof OpenIdConnectAuthScheme) {
    const token = await promptSecret('Enter OIDC token');
    if (!token) throw new Error('No token provided');
    scheme.setCredential(token); return;
  }
  throw new Error(`Unsupported auth scheme: ${scheme.constructor.name}`);
}

export class CliAuthProvider implements AuthProvider {
  private selectedGroupIndex?: number;

  constructor(private readonly policyKey: string) {}

  async provide(requirements: AuthScheme[][]): Promise<AuthScheme[]> {
    const stored = loadCredentials(this.policyKey);
    if (stored?.length) {
      for (const [groupIndex, group] of requirements.entries()) {
        if (this._tryRestore(groupIndex, group, stored)) {
          this.selectedGroupIndex = groupIndex;
          return group;
        }
      }
    }

    console.log(chalk.magenta.bold('\nAuthentication required by this agent.'));

    let groupIndex: number;
    if (requirements.length === 1) {
      groupIndex = 0;
      console.log(chalk.gray(`  Scheme: ${requirements[0].map(schemeLabel).join(' + ')}`));
    } else {
      console.log(chalk.gray('  Available authentication methods:'));
      requirements.forEach((g, i) =>
        console.log(chalk.gray(`    ${i + 1}. ${g.map(schemeLabel).join(' + ')}`)));
      const choice = await prompt(chalk.yellow(`  Select method (1-${requirements.length}): `));
      groupIndex = parseInt(choice, 10) - 1;
      if (isNaN(groupIndex) || groupIndex < 0 || groupIndex >= requirements.length) {
        throw new Error('Invalid selection');
      }
    }

    const group = requirements[groupIndex];
    for (const scheme of group) await resolveScheme(scheme);
    console.log('');
    this.selectedGroupIndex = groupIndex;
    this._save(groupIndex, group);
    return group;
  }

  async refresh(schemes: AuthScheme[]): Promise<AuthScheme[]> {
    if (this.selectedGroupIndex === undefined) {
      throw new Error('Cannot refresh before selecting an auth group');
    }
    clearCredentials(this.policyKey);
    console.log(chalk.magenta.bold('\nAuthentication expired. Please re-authenticate.'));
    for (const scheme of schemes) await resolveScheme(scheme);
    console.log('');
    this._save(this.selectedGroupIndex, schemes);
    return schemes;
  }

  private _tryRestore(
    groupIndex: number,
    group: AuthScheme[],
    stored: { slot: string; credential: string }[],
  ) {
    for (const [schemeIndex, scheme] of group.entries()) {
      const slot = credentialSlot(groupIndex, schemeIndex, scheme);
      const match = stored.find(s => s.slot === slot);
      if (!match) return false;
      scheme.setCredential(match.credential);
    }
    return true;
  }

  private _save(groupIndex: number, group: AuthScheme[]) {
    saveCredentials(
      this.policyKey,
      group.map((scheme, schemeIndex) =>
        extractCredential(credentialSlot(groupIndex, schemeIndex, scheme), scheme),
      ),
    );
  }
}
```

Keep `readline` for the non-secret method menu only. Never fall back to echoed secret input on a non-interactive stdin; accept secrets through a protected environment, file descriptor, or credential store instead.

---

## `commands/send.ts`

```typescript
import { Command } from 'commander';
import crypto from 'node:crypto';
import {
  A2XClient,
  getAgentEndpointUrl,
  resolveAgentCard,
} from '@a2x/sdk/client';
import type { SendMessageParams } from '@a2x/sdk';
import { CliAuthProvider } from '../cli-auth-provider.js';
import { credentialPolicyKey } from '../token-store.js';

export function parseHeaders(headerArgs?: string[]): Record<string, string> | undefined {
  if (!headerArgs?.length) return undefined;
  const headers: Record<string, string> = {};
  for (const h of headerArgs) {
    const idx = h.indexOf(':');
    if (idx > 0) headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

export const sendCommand = new Command('send')
  .description('Send a message to an A2A agent (blocking)')
  .argument('<url>', 'Agent base URL')
  .argument('<message>', 'Message text')
  .option('--context-id <id>')
  .option('-H, --header <header...>')
  .action(async (url: string, message: string, opts: { contextId?: string; header?: string[] }) => {
    const headers = parseHeaders(opts.header);
    const noRedirectFetch: typeof fetch = (input, init) =>
      fetch(input, { ...init, redirect: 'error' });
    const resolved = await resolveAgentCard(url, { headers, fetch: noRedirectFetch });
    const endpoint = getAgentEndpointUrl(resolved.card, resolved.version);
    if (
      url !== process.env.A2X_APPROVED_AGENT_CARD_URL ||
      endpoint !== process.env.A2X_APPROVED_AGENT_ENDPOINT
    ) {
      throw new Error('Agent card or endpoint is outside the credential policy');
    }
    const identityPolicyId = process.env.A2X_CREDENTIAL_POLICY_ID;
    if (!identityPolicyId) throw new Error('A2X_CREDENTIAL_POLICY_ID is required');
    const policyKey = credentialPolicyKey(url, endpoint, identityPolicyId);
    const client = new A2XClient(resolved.card, {
      headers,
      fetch: noRedirectFetch,
      authProvider: new CliAuthProvider(policyKey),
    });

    const params: SendMessageParams = {
      message: {
        messageId: crypto.randomUUID(),
        role: 'user',
        parts: [{ text: message }],
      },
    };
    if (opts.contextId) params.message.contextId = opts.contextId;

    const task = await client.sendMessage(params);
    // pretty-print task — see packages/cli/src/format.ts for a full implementation
    console.log(JSON.stringify(task, null, 2));
});
```

The credential-bearing commands intentionally refuse arbitrary URLs.
`A2X_APPROVED_AGENT_CARD_URL` and `A2X_APPROVED_AGENT_ENDPOINT` must be exact,
credential-free deployment-policy URLs, while `A2X_CREDENTIAL_POLICY_ID` binds
the approved issuer/client/audience/scope policy version. If your CLI must call
an arbitrary URL, disable automatic credential restoration and OAuth there;
prompt for a credential explicitly scoped to the newly verified endpoint.

---

## `commands/stream.ts`

```typescript
import { Command } from 'commander';
import crypto from 'node:crypto';
import {
  A2XClient,
  getAgentEndpointUrl,
  resolveAgentCard,
} from '@a2x/sdk/client';
import type { SendMessageParams } from '@a2x/sdk';
import { CliAuthProvider } from '../cli-auth-provider.js';
import { parseHeaders } from './send.js';
import { credentialPolicyKey } from '../token-store.js';

export const streamCommand = new Command('stream')
  .description('Send a message and stream the response')
  .argument('<url>')
  .argument('<message>')
  .option('--context-id <id>')
  .option('-H, --header <header...>')
  .action(async (url: string, message: string, opts: { contextId?: string; header?: string[] }) => {
    const headers = parseHeaders(opts.header);
    const noRedirectFetch: typeof fetch = (input, init) =>
      fetch(input, { ...init, redirect: 'error' });
    const resolved = await resolveAgentCard(url, { headers, fetch: noRedirectFetch });
    const endpoint = getAgentEndpointUrl(resolved.card, resolved.version);
    if (
      url !== process.env.A2X_APPROVED_AGENT_CARD_URL ||
      endpoint !== process.env.A2X_APPROVED_AGENT_ENDPOINT
    ) {
      throw new Error('Agent card or endpoint is outside the credential policy');
    }
    const identityPolicyId = process.env.A2X_CREDENTIAL_POLICY_ID;
    if (!identityPolicyId) throw new Error('A2X_CREDENTIAL_POLICY_ID is required');
    const policyKey = credentialPolicyKey(url, endpoint, identityPolicyId);
    const client = new A2XClient(resolved.card, {
      headers,
      fetch: noRedirectFetch,
      authProvider: new CliAuthProvider(policyKey),
    });

    const params: SendMessageParams = {
      message: {
        messageId: crypto.randomUUID(),
        role: 'user',
        parts: [{ text: message }],
      },
    };
    if (opts.contextId) params.message.contextId = opts.contextId;

    for await (const event of client.sendMessageStream(params)) {
      if ('status' in event) {
        process.stderr.write(`[${event.status.state}] `);
      } else {
        for (const part of event.artifact.parts) {
          if ('text' in part) process.stdout.write(part.text);
        }
      }
    }
    process.stdout.write('\n');
  });
```

---

## `index.ts` (entrypoint)

```typescript
#!/usr/bin/env node
import { Command } from 'commander';
import { sendCommand } from './commands/send.js';
import { streamCommand } from './commands/stream.js';

const program = new Command()
  .name('my-cli')
  .description('Interactive A2A agent client')
  .version('0.1.0');

program.addCommand(sendCommand);
program.addCommand(streamCommand);

program.parse();
```

---

## Dependencies

`package.json`:

```json
{
  "name": "my-cli",
  "type": "module",
  "bin": { "my-cli": "./dist/index.js" },
  "dependencies": {
    "@a2x/sdk": "latest",
    "@inquirer/prompts": "latest",
    "chalk": "^5",
    "commander": "^12"
  },
  "devDependencies": {
    "@types/node": "^22",
    "typescript": "^5",
    "tsup": "^8"
  }
}
```

---

## Testing the Full Chain

1. Run against an unauthenticated agent — no prompting should happen.
2. Run against an agent with `{ apiKey: [] }` — first run prompts, second run reads from store.
3. Manually break the stored credential (edit `~/.<your-cli>/tokens.json`) and have the test agent return `auth-required` — the next run should re-prompt via `refresh()`.
4. Run against an agent with OAuth2 device code — confirm the verification URL and polling behavior.
5. Run against an agent with multiple auth groups — confirm the menu works and your choice persists.

If the CLI hangs on step 4, check that your `interval` respect is correct and `authorization_pending` isn't being treated as fatal.
