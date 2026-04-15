/**
 * Layer 1: HttpBearerAuthorization security scheme.
 */

import type { SecuritySchemeV03, SecuritySchemeV10 } from '../types/security.js';
import type { RequestContext, AuthResult } from '../types/auth.js';
import { BaseSecurityScheme } from './base.js';

export interface HttpBearerAuthorizationOptions {
  scheme: string;
  bearerFormat?: string;
  description?: string;
  /** Token validator callback. Receives the extracted token string. */
  validator?: (token: string) => Promise<AuthResult> | AuthResult;
}

export class HttpBearerAuthorization extends BaseSecurityScheme {
  readonly scheme: string;
  readonly bearerFormat?: string;
  private readonly _validator?: (token: string) => Promise<AuthResult> | AuthResult;

  constructor(options: HttpBearerAuthorizationOptions) {
    super(options.description);
    this.validateRequired({ scheme: options.scheme }, 'HttpBearerAuthorization');
    this.scheme = options.scheme;
    this.bearerFormat = options.bearerFormat;
    this._validator = options.validator;
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

  async authenticate(context: RequestContext): Promise<AuthResult> {
    // No validator → pass-through
    if (!this._validator) {
      return { authenticated: true };
    }

    // Extract Authorization header
    const authHeader = this.getHeader(context, 'authorization');
    if (!authHeader) {
      return {
        authenticated: false,
        error: 'Missing Authorization header',
      };
    }

    // Parse "<scheme> <token>"
    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== this.scheme.toLowerCase()) {
      return {
        authenticated: false,
        error: `Invalid Authorization header. Expected scheme: ${this.scheme}`,
      };
    }

    return this._validator(parts[1]);
  }
}
