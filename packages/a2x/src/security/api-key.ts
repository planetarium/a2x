/**
 * Layer 1: ApiKeyAuthorization security scheme.
 */

import type { SecuritySchemeV03, SecuritySchemeV10 } from '../types/security.js';
import { BaseSecurityScheme } from './base.js';

export interface ApiKeyAuthorizationOptions {
  in: 'header' | 'query' | 'cookie';
  name: string;
  description?: string;
}

export class ApiKeyAuthorization extends BaseSecurityScheme {
  readonly in: 'header' | 'query' | 'cookie';
  readonly name: string;

  constructor(options: ApiKeyAuthorizationOptions) {
    super(options.description);
    this.validateRequired(
      { in: options.in, name: options.name },
      'ApiKeyAuthorization',
    );
    this.in = options.in;
    this.name = options.name;
  }

  toV03Schema(): SecuritySchemeV03 {
    const schema: SecuritySchemeV03 = {
      type: 'apiKey',
      in: this.in,
      name: this.name,
    };
    if (this.description) {
      (schema as { description?: string }).description = this.description;
    }
    return schema;
  }

  toV10Schema(): SecuritySchemeV10 {
    return {
      apiKeySecurityScheme: {
        location: this.in, // v1.0 uses "location" instead of "in"
        name: this.name,
        ...(this.description ? { description: this.description } : {}),
      },
    };
  }
}
