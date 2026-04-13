/**
 * Layer 1: HttpBearerAuthorization security scheme.
 */

import type { SecuritySchemeV03, SecuritySchemeV10 } from '../types/security.js';
import { BaseSecurityScheme } from './base.js';

export interface HttpBearerAuthorizationOptions {
  scheme: string;
  bearerFormat?: string;
  description?: string;
}

export class HttpBearerAuthorization extends BaseSecurityScheme {
  readonly scheme: string;
  readonly bearerFormat?: string;

  constructor(options: HttpBearerAuthorizationOptions) {
    super(options.description);
    this.validateRequired({ scheme: options.scheme }, 'HttpBearerAuthorization');
    this.scheme = options.scheme;
    this.bearerFormat = options.bearerFormat;
  }

  toV03Schema(): SecuritySchemeV03 {
    const schema: SecuritySchemeV03 = {
      type: 'http',
      scheme: this.scheme,
    };
    if (this.bearerFormat) {
      (schema as { bearerFormat?: string }).bearerFormat = this.bearerFormat;
    }
    if (this.description) {
      (schema as { description?: string }).description = this.description;
    }
    return schema;
  }

  toV10Schema(): SecuritySchemeV10 {
    return {
      httpAuthSecurityScheme: {
        scheme: this.scheme,
        ...(this.bearerFormat ? { bearerFormat: this.bearerFormat } : {}),
        ...(this.description ? { description: this.description } : {}),
      },
    };
  }
}
