/**
 * Client-side authentication providers.
 *
 * AuthProvider implementations inject credentials into outgoing HTTP requests.
 * The A2XClient calls `applyAuth()` before every request.
 */

import type { AgentCardV03, AgentCardV10 } from '../types/agent-card.js';

// ─── AuthProvider Interface ───

export interface AuthProvider {
  /**
   * Mutate the outgoing request headers to include authentication credentials.
   * Called before every HTTP request the client makes.
   */
  applyAuth(headers: Record<string, string>): Promise<void> | void;
}

// ─── Built-in Providers ───

/**
 * Injects an API key into a specific header, query parameter, or cookie.
 *
 * @example
 * ```ts
 * new ApiKeyAuthProvider({ headerName: 'x-api-key', key: 'my-secret' })
 * ```
 */
export class ApiKeyAuthProvider implements AuthProvider {
  private readonly _headerName: string;
  private readonly _key: string;

  constructor(options: { headerName: string; key: string }) {
    this._headerName = options.headerName.toLowerCase();
    this._key = options.key;
  }

  applyAuth(headers: Record<string, string>): void {
    headers[this._headerName] = this._key;
  }
}

/**
 * Injects a Bearer token into the Authorization header.
 *
 * @example
 * ```ts
 * new BearerTokenAuthProvider({ token: 'eyJhbG...' })
 * ```
 */
export class BearerTokenAuthProvider implements AuthProvider {
  private readonly _token: string;

  constructor(options: { token: string }) {
    this._token = options.token;
  }

  applyAuth(headers: Record<string, string>): void {
    headers['authorization'] = `Bearer ${this._token}`;
  }
}

// ─── Auto-resolve from AgentCard ───

export interface AuthCredentials {
  apiKey?: string;
  token?: string;
}

/**
 * Create an AuthProvider by matching user credentials against the
 * AgentCard's declared security schemes.
 *
 * - `apiKey` → reads the scheme's header name from the card
 * - `token` → always maps to `Authorization: Bearer <token>`
 *
 * Returns undefined if no matching credentials are provided.
 */
export function createAuthFromAgentCard(
  card: AgentCardV03 | AgentCardV10,
  credentials: AuthCredentials,
): AuthProvider | undefined {
  if (credentials.token) {
    return new BearerTokenAuthProvider({ token: credentials.token });
  }

  if (credentials.apiKey) {
    const headerName = resolveApiKeyHeaderName(card);
    return new ApiKeyAuthProvider({
      headerName: headerName ?? 'x-api-key',
      key: credentials.apiKey,
    });
  }

  return undefined;
}

/**
 * Extract the API key header name from an AgentCard's security schemes.
 * Searches for the first apiKey-type scheme and returns its name field.
 */
function resolveApiKeyHeaderName(
  card: AgentCardV03 | AgentCardV10,
): string | undefined {
  const raw = card as unknown as Record<string, unknown>;

  // v0.3: securitySchemes is Record<string, { type, in, name }>
  // v1.0: securitySchemes is Record<string, { apiKeySecurityScheme?: { name, location } }>
  const schemes =
    (raw.securitySchemes as Record<string, Record<string, unknown>> | undefined) ??
    (raw.securityDefinitions as Record<string, Record<string, unknown>> | undefined);

  if (!schemes) return undefined;

  for (const scheme of Object.values(schemes)) {
    // v0.3 format
    if (scheme.type === 'apiKey' && typeof scheme.name === 'string') {
      return scheme.name;
    }
    // v1.0 format
    const apiKeyScheme = scheme.apiKeySecurityScheme as
      | Record<string, unknown>
      | undefined;
    if (apiKeyScheme && typeof apiKeyScheme.name === 'string') {
      return apiKeyScheme.name;
    }
  }

  return undefined;
}
