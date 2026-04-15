/**
 * Layer 1: ApiKeyAuthorization security scheme.
 */

import type { SecuritySchemeV03, SecuritySchemeV10 } from '../types/security.js';
import type { RequestContext, AuthResult } from '../types/auth.js';
import { BaseSecurityScheme } from './base.js';

export interface ApiKeyAuthorizationOptions {
  in: 'header' | 'query' | 'cookie';
  name: string;
  description?: string;
  /** List of valid API keys. Built-in comparison. */
  keys?: string[];
  /** Custom validator. Takes precedence over `keys` if both are provided. */
  validator?: (key: string) => Promise<AuthResult> | AuthResult;
}

export class ApiKeyAuthorization extends BaseSecurityScheme {
  readonly in: 'header' | 'query' | 'cookie';
  readonly name: string;
  private readonly _keys?: string[];
  private readonly _validator?: (key: string) => Promise<AuthResult> | AuthResult;

  constructor(options: ApiKeyAuthorizationOptions) {
    super(options.description);
    this.validateRequired(
      { in: options.in, name: options.name },
      'ApiKeyAuthorization',
    );
    this.in = options.in;
    this.name = options.name;
    this._keys = options.keys;
    this._validator = options.validator;
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

  async authenticate(context: RequestContext): Promise<AuthResult> {
    // No validation config → pass-through
    if (!this._keys && !this._validator) {
      return { authenticated: true };
    }

    // Extract key from the configured location
    const key = this._extractKey(context);
    if (!key) {
      return {
        authenticated: false,
        error: `Missing API key in ${this.in}: ${this.name}`,
      };
    }

    // Custom validator takes precedence
    if (this._validator) {
      return this._validator(key);
    }

    // Built-in comparison
    if (this._keys && this._keys.includes(key)) {
      return { authenticated: true, principal: { apiKey: key } };
    }

    return { authenticated: false, error: 'Invalid API key' };
  }

  private _extractKey(context: RequestContext): string | undefined {
    switch (this.in) {
      case 'header':
        return this.getHeader(context, this.name);
      case 'query': {
        const val = context.query?.[this.name];
        return Array.isArray(val) ? val[0] : val;
      }
      case 'cookie':
        return context.cookies?.[this.name];
    }
  }
}
