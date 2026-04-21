/**
 * Interactive CLI AuthProvider.
 *
 * Prompts the user for credentials when an agent requires authentication.
 * Iterates through requirement groups (OR) and schemes within each group (AND),
 * resolving credentials interactively based on scheme type.
 */

import * as readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import chalk from 'chalk';
import type { AuthProvider } from '@a2x/sdk';
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
} from '@a2x/sdk';
import { loadCredentials, saveCredentials, clearCredentials } from './token-store.js';

async function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(question);
    return answer.trim();
  } finally {
    rl.close();
  }
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

// ─── OAuth2 Device Code Flow ───

interface DeviceAuthResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in?: number;
  interval?: number;
}

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in?: number;
  refresh_token?: string;
  scope?: string;
}

interface TokenErrorResponse {
  error: string;
  error_description?: string;
}

const CLI_CLIENT_ID = 'a2x-cli';

async function performDeviceCodeFlow(
  scheme: OAuth2DeviceCodeAuthScheme,
): Promise<string> {
  const { deviceAuthorizationUrl, tokenUrl, scopes } = scheme.params;

  // Step 1: Request device code
  const scopeStr = Object.keys(scopes).join(' ');
  const deviceRes = await fetch(deviceAuthorizationUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLI_CLIENT_ID,
      ...(scopeStr ? { scope: scopeStr } : {}),
    }),
  });

  if (!deviceRes.ok) {
    throw new Error(
      `Device authorization failed: HTTP ${deviceRes.status} ${deviceRes.statusText}`,
    );
  }

  const deviceData = (await deviceRes.json()) as DeviceAuthResponse;
  const pollInterval = (deviceData.interval ?? 5) * 1000;

  // Step 2: Display instructions
  console.log('');
  console.log(
    chalk.bold('  To authenticate, visit:'),
  );
  console.log(
    chalk.cyan.bold(`  ${deviceData.verification_uri_complete ?? deviceData.verification_uri}`),
  );
  if (!deviceData.verification_uri_complete) {
    console.log(
      chalk.bold(`  and enter code: `) + chalk.cyan.bold(deviceData.user_code),
    );
  }
  console.log('');
  process.stdout.write(chalk.gray('  Waiting for authorization...'));

  // Step 3: Poll token endpoint
  const deadline = Date.now() + (deviceData.expires_in ?? 300) * 1000;

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const tokenRes = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        device_code: deviceData.device_code,
        client_id: CLI_CLIENT_ID,
      }),
    });

    const tokenData = (await tokenRes.json()) as
      | TokenResponse
      | TokenErrorResponse;

    if ('access_token' in tokenData) {
      console.log(chalk.green(' Authorized!'));
      return tokenData.access_token;
    }

    const errorData = tokenData as TokenErrorResponse;
    if (errorData.error === 'authorization_pending') {
      process.stdout.write(chalk.gray('.'));
      continue;
    }
    if (errorData.error === 'slow_down') {
      // Back off
      await new Promise((r) => setTimeout(r, pollInterval));
      continue;
    }

    // Any other error is fatal
    console.log(chalk.red(' Failed'));
    throw new Error(
      errorData.error_description ?? errorData.error ?? 'Token request failed',
    );
  }

  console.log(chalk.red(' Expired'));
  throw new Error('Device code expired before authorization was completed');
}

// ─── Scheme Resolution ───

async function resolveScheme(scheme: AuthScheme): Promise<void> {
  if (scheme instanceof ApiKeyAuthScheme) {
    const key = await prompt(
      chalk.yellow(`  Enter API key (${scheme.params.name}): `),
    );
    if (!key) throw new Error('No API key provided');
    scheme.setCredential(key);
    return;
  }

  if (scheme instanceof HttpBearerAuthScheme) {
    const token = await prompt(chalk.yellow('  Enter Bearer token: '));
    if (!token) throw new Error('No token provided');
    scheme.setCredential(token);
    return;
  }

  if (scheme instanceof HttpBasicAuthScheme) {
    const cred = await prompt(
      chalk.yellow('  Enter Basic credentials (base64): '),
    );
    if (!cred) throw new Error('No credentials provided');
    scheme.setCredential(cred);
    return;
  }

  if (scheme instanceof OAuth2DeviceCodeAuthScheme) {
    const token = await performDeviceCodeFlow(scheme);
    scheme.setCredential(token);
    return;
  }

  if (
    scheme instanceof OAuth2AuthorizationCodeAuthScheme ||
    scheme instanceof OAuth2ClientCredentialsAuthScheme ||
    scheme instanceof OAuth2ImplicitAuthScheme ||
    scheme instanceof OAuth2PasswordAuthScheme
  ) {
    const token = await prompt(chalk.yellow('  Enter access token: '));
    if (!token) throw new Error('No token provided');
    scheme.setCredential(token);
    return;
  }

  if (scheme instanceof OpenIdConnectAuthScheme) {
    const token = await prompt(chalk.yellow('  Enter OIDC token: '));
    if (!token) throw new Error('No token provided');
    scheme.setCredential(token);
    return;
  }

  throw new Error(`Unsupported auth scheme: ${scheme.constructor.name}`);
}

function extractCredential(scheme: AuthScheme): { schemeClass: string; credential: string } {
  // Access the protected credential via a known side effect:
  // applyToRequest sets headers, so we can extract from there.
  const ctx = { headers: {} as Record<string, string>, url: new URL('http://dummy') };
  scheme.applyToRequest(ctx);

  let credential = '';
  const className = scheme.constructor.name;

  if (scheme instanceof ApiKeyAuthScheme) {
    credential = ctx.headers[scheme.params.name]
      ?? ctx.url.searchParams.get(scheme.params.name)
      ?? '';
  } else {
    // Bearer-style: extract token from "Bearer xxx" or "Basic xxx"
    const auth = ctx.headers['Authorization'] ?? '';
    const spaceIdx = auth.indexOf(' ');
    credential = spaceIdx >= 0 ? auth.slice(spaceIdx + 1) : auth;
  }

  return { schemeClass: className, credential };
}

export class CliAuthProvider implements AuthProvider {
  constructor(private readonly agentUrl: string) {}

  async provide(requirements: AuthScheme[][]): Promise<AuthScheme[]> {
    // Try stored credentials first
    const stored = loadCredentials(this.agentUrl);
    if (stored?.length) {
      for (const group of requirements) {
        if (this._tryRestore(group, stored)) {
          return group;
        }
      }
      // Stored credentials didn't match any group — fall through to interactive
    }

    console.log(
      chalk.magenta.bold('\nAuthentication required by this agent.'),
    );

    let group: AuthScheme[];

    if (requirements.length === 1) {
      group = requirements[0];
      console.log(
        chalk.gray(
          `  Scheme: ${group.map(schemeLabel).join(' + ')}`,
        ),
      );
    } else {
      // Multiple groups — let the user pick
      console.log(chalk.gray('  Available authentication methods:'));
      for (let i = 0; i < requirements.length; i++) {
        console.log(
          chalk.gray(`    ${i + 1}. ${requirements[i].map(schemeLabel).join(' + ')}`),
        );
      }

      const choice = await prompt(
        chalk.yellow(`  Select method (1-${requirements.length}): `),
      );
      const idx = parseInt(choice, 10) - 1;
      if (isNaN(idx) || idx < 0 || idx >= requirements.length) {
        throw new Error('Invalid selection');
      }
      group = requirements[idx];
    }

    for (const scheme of group) {
      await resolveScheme(scheme);
    }
    console.log('');

    // Save credentials for next time
    this._save(group);

    return group;
  }

  async refresh(schemes: AuthScheme[]): Promise<AuthScheme[]> {
    // Clear stored credentials — they're no longer valid
    clearCredentials(this.agentUrl);

    console.log(
      chalk.magenta.bold('\nAuthentication expired. Please re-authenticate.'),
    );
    for (const scheme of schemes) {
      await resolveScheme(scheme);
    }
    console.log('');

    // Save new credentials
    this._save(schemes);

    return schemes;
  }

  /**
   * Try to restore stored credentials onto a requirement group.
   * Returns true if all schemes in the group were matched and restored.
   */
  private _tryRestore(
    group: AuthScheme[],
    stored: Array<{ schemeClass: string; credential: string }>,
  ): boolean {
    for (const scheme of group) {
      const match = stored.find((s) => s.schemeClass === scheme.constructor.name);
      if (!match) return false;
      scheme.setCredential(match.credential);
    }
    return true;
  }

  private _save(group: AuthScheme[]): void {
    const entries = group.map(extractCredential);
    saveCredentials(this.agentUrl, entries);
  }
}
