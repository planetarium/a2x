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
  schemeClass: string;
  credential: string;
}
export function loadCredentials(agentUrl: string): StoredCredential[] | undefined;
export function saveCredentials(agentUrl: string, credentials: StoredCredential[]): void;
export function clearCredentials(agentUrl: string): void;
```

File path: `path.join(os.homedir(), '.<your-cli-name>', 'tokens.json')`.

---

## `device-code.ts`

See [oauth2-device-code.md](./oauth2-device-code.md). Exports:

```typescript
export async function performDeviceCodeFlow(
  scheme: OAuth2DeviceCodeAuthScheme,
): Promise<string>;
```

---

## `cli-auth-provider.ts` — Full Chain

See [auth-fallback-chain.md](./auth-fallback-chain.md) for the complete reference. The shortest integration:

```typescript
import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
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
import { loadCredentials, saveCredentials, clearCredentials } from './token-store.js';
import { performDeviceCodeFlow } from './device-code.js';

async function prompt(q: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try { return (await rl.question(q)).trim(); } finally { rl.close(); }
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
    const key = await prompt(chalk.yellow(`  Enter API key (${scheme.params.name}): `));
    if (!key) throw new Error('No API key provided');
    scheme.setCredential(key); return;
  }
  if (scheme instanceof HttpBearerAuthScheme) {
    const token = await prompt(chalk.yellow('  Enter Bearer token: '));
    if (!token) throw new Error('No token provided');
    scheme.setCredential(token); return;
  }
  if (scheme instanceof HttpBasicAuthScheme) {
    const cred = await prompt(chalk.yellow('  Enter Basic credentials (base64): '));
    if (!cred) throw new Error('No credentials provided');
    scheme.setCredential(cred); return;
  }
  if (scheme instanceof OAuth2DeviceCodeAuthScheme) {
    const token = await performDeviceCodeFlow(scheme);
    scheme.setCredential(token); return;
  }
  if (
    scheme instanceof OAuth2AuthorizationCodeAuthScheme ||
    scheme instanceof OAuth2ClientCredentialsAuthScheme ||
    scheme instanceof OAuth2ImplicitAuthScheme ||
    scheme instanceof OAuth2PasswordAuthScheme
  ) {
    const token = await prompt(chalk.yellow('  Enter access token: '));
    if (!token) throw new Error('No token provided');
    scheme.setCredential(token); return;
  }
  if (scheme instanceof OpenIdConnectAuthScheme) {
    const token = await prompt(chalk.yellow('  Enter OIDC token: '));
    if (!token) throw new Error('No token provided');
    scheme.setCredential(token); return;
  }
  throw new Error(`Unsupported auth scheme: ${scheme.constructor.name}`);
}

function extractCredential(scheme: AuthScheme): { schemeClass: string; credential: string } {
  const ctx = { headers: {} as Record<string, string>, url: new URL('http://dummy') };
  scheme.applyToRequest(ctx);
  let credential = '';
  if (scheme instanceof ApiKeyAuthScheme) {
    credential = ctx.headers[scheme.params.name]
      ?? ctx.url.searchParams.get(scheme.params.name) ?? '';
  } else {
    const auth = ctx.headers['Authorization'] ?? '';
    const spaceIdx = auth.indexOf(' ');
    credential = spaceIdx >= 0 ? auth.slice(spaceIdx + 1) : auth;
  }
  return { schemeClass: scheme.constructor.name, credential };
}

export class CliAuthProvider implements AuthProvider {
  constructor(private readonly agentUrl: string) {}

  async provide(requirements: AuthScheme[][]): Promise<AuthScheme[]> {
    const stored = loadCredentials(this.agentUrl);
    if (stored?.length) {
      for (const group of requirements) {
        if (this._tryRestore(group, stored)) return group;
      }
    }

    console.log(chalk.magenta.bold('\nAuthentication required by this agent.'));

    let group: AuthScheme[];
    if (requirements.length === 1) {
      group = requirements[0];
      console.log(chalk.gray(`  Scheme: ${group.map(schemeLabel).join(' + ')}`));
    } else {
      console.log(chalk.gray('  Available authentication methods:'));
      requirements.forEach((g, i) =>
        console.log(chalk.gray(`    ${i + 1}. ${g.map(schemeLabel).join(' + ')}`)));
      const choice = await prompt(chalk.yellow(`  Select method (1-${requirements.length}): `));
      const idx = parseInt(choice, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= requirements.length) throw new Error('Invalid selection');
      group = requirements[idx];
    }

    for (const scheme of group) await resolveScheme(scheme);
    console.log('');
    this._save(group);
    return group;
  }

  async refresh(schemes: AuthScheme[]): Promise<AuthScheme[]> {
    clearCredentials(this.agentUrl);
    console.log(chalk.magenta.bold('\nAuthentication expired. Please re-authenticate.'));
    for (const scheme of schemes) await resolveScheme(scheme);
    console.log('');
    this._save(schemes);
    return schemes;
  }

  private _tryRestore(group: AuthScheme[], stored: { schemeClass: string; credential: string }[]) {
    for (const scheme of group) {
      const match = stored.find(s => s.schemeClass === scheme.constructor.name);
      if (!match) return false;
      scheme.setCredential(match.credential);
    }
    return true;
  }

  private _save(group: AuthScheme[]) {
    saveCredentials(this.agentUrl, group.map(extractCredential));
  }
}
```

---

## `commands/send.ts`

```typescript
import { Command } from 'commander';
import crypto from 'node:crypto';
import { A2XClient } from '@a2x/sdk/client';
import type { SendMessageParams } from '@a2x/sdk';
import { CliAuthProvider } from '../cli-auth-provider.js';

function parseHeaders(headerArgs?: string[]): Record<string, string> | undefined {
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
    const client = new A2XClient(url, {
      headers: parseHeaders(opts.header),
      authProvider: new CliAuthProvider(url),
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

---

## `commands/stream.ts`

```typescript
import { Command } from 'commander';
import crypto from 'node:crypto';
import { A2XClient } from '@a2x/sdk/client';
import type { SendMessageParams } from '@a2x/sdk';
import { CliAuthProvider } from '../cli-auth-provider.js';

export const streamCommand = new Command('stream')
  .description('Send a message and stream the response')
  .argument('<url>')
  .argument('<message>')
  .option('--context-id <id>')
  .option('-H, --header <header...>')
  .action(async (url: string, message: string, opts: { contextId?: string; header?: string[] }) => {
    const client = new A2XClient(url, {
      headers: parseHeaders(opts.header),
      authProvider: new CliAuthProvider(url),
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
3. Manually break the stored credential (edit `~/.<your-cli>/tokens.json`) — the next run should hit 401 and re-prompt via `refresh()`.
4. Run against an agent with OAuth2 device code — confirm the verification URL and polling behavior.
5. Run against an agent with multiple auth groups — confirm the menu works and your choice persists.

If the CLI hangs on step 4, check that your `interval` respect is correct and `authorization_pending` isn't being treated as fatal.
