/**
 * Layer 1: BaseSecurityScheme abstract class.
 */

import type { SecuritySchemeV03, SecuritySchemeV10 } from '../types/security.js';

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
}
