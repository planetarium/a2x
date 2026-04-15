/**
 * Layer 1: BaseSecurityScheme abstract class.
 */

import type { SecuritySchemeV03, SecuritySchemeV10 } from '../types/security.js';
import type { RequestContext, AuthResult } from '../types/auth.js';

export abstract class BaseSecurityScheme {
  readonly description?: string;

  constructor(description?: string) {
    this.description = description;
  }

  /**
   * Convert to v0.3 SecurityScheme format.
   * Returns null if this scheme is not supported in v0.3.
   */
  abstract toV03Schema(): SecuritySchemeV03 | null;

  /**
   * Convert to v1.0 SecurityScheme format.
   */
  abstract toV10Schema(): SecuritySchemeV10;

  /**
   * Authenticate an incoming request against this security scheme.
   *
   * Default implementation returns pass-through (authenticated: true),
   * which preserves backward compatibility for scheme instances used
   * only for AgentCard schema generation.
   *
   * Subclasses override this when validation config (keys, validator, etc.)
   * is provided in their constructor options.
   */
  async authenticate(_context: RequestContext): Promise<AuthResult> {
    return { authenticated: true };
  }

  /**
   * Validate that required fields are present.
   * Throws an Error if validation fails.
   */
  protected validateRequired(
    fields: Record<string, unknown>,
    className: string,
  ): void {
    for (const [name, value] of Object.entries(fields)) {
      if (value === undefined || value === null || value === '') {
        throw new Error(
          `${className}: required field '${name}' is missing or empty`,
        );
      }
    }
  }

  /**
   * Extract a single header value from the request context.
   * Returns the first value if the header has multiple values.
   */
  protected getHeader(
    context: RequestContext,
    name: string,
  ): string | undefined {
    const value = context.headers[name] ?? context.headers[name.toLowerCase()];
    if (Array.isArray(value)) {
      return value[0];
    }
    return value;
  }
}
