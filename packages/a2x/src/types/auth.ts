/**
 * Layer 1: Authentication types for runtime security validation.
 *
 * These types enable security scheme classes to perform actual request
 * authentication, not just AgentCard schema generation.
 */

// ─── RequestContext ───

/**
 * Framework-agnostic HTTP request context.
 * Callers construct this from their framework's request object.
 *
 * @example Express
 * ```ts
 * const context: RequestContext = { headers: req.headers, query: req.query, cookies: req.cookies };
 * ```
 *
 * @example Next.js App Router
 * ```ts
 * const context: RequestContext = { headers: Object.fromEntries(request.headers.entries()) };
 * ```
 */
export interface RequestContext {
  headers: Record<string, string | string[] | undefined>;
  query?: Record<string, string | string[] | undefined>;
  cookies?: Record<string, string | undefined>;
  clientCertificate?: ClientCertificate;
}

// ─── ClientCertificate ───

/**
 * Client certificate information for mutual TLS authentication.
 * Populated from the TLS socket or reverse proxy headers.
 */
export interface ClientCertificate {
  fingerprint?: string;
  subject?: string;
  issuer?: string;
  raw?: string;
}

// ─── AuthResult ───

/**
 * Result of a security scheme's `authenticate()` call.
 */
export interface AuthResult {
  authenticated: boolean;
  /** Decoded token payload, user info, or any identity data. */
  principal?: unknown;
  /** Reason for authentication failure. */
  error?: string;
  /** Granted scopes (relevant for OAuth2 / OIDC). */
  scopes?: string[];
}
