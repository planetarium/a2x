/**
 * Layer 1: OpenIdConnectAuthorization security scheme.
 */

import type { SecuritySchemeV03, SecuritySchemeV10 } from '../types/security.js';
import type { RequestContext, AuthResult } from '../types/auth.js';
import { BaseSecurityScheme } from './base.js';

export interface OpenIdConnectAuthorizationOptions {
  openIdConnectUrl: string;
  description?: string;
  /**
   * Custom token validator. Receives the extracted bearer token.
   * Use this to override automatic OIDC validation or for custom logic.
   */
  validator?: (token: string) => Promise<AuthResult> | AuthResult;
}

export class OpenIdConnectAuthorization extends BaseSecurityScheme {
  readonly openIdConnectUrl: string;
  private readonly _validator?: (token: string) => Promise<AuthResult> | AuthResult;

  constructor(options: OpenIdConnectAuthorizationOptions) {
    super(options.description);
    this.validateRequired(
      { openIdConnectUrl: options.openIdConnectUrl },
      'OpenIdConnectAuthorization',
    );
    this.openIdConnectUrl = options.openIdConnectUrl;
    this._validator = options.validator;
  }

  toV03Schema(): SecuritySchemeV03 {
    return {
      type: 'openIdConnect',
      openIdConnectUrl: this.openIdConnectUrl,
      ...(this.description ? { description: this.description } : {}),
    };
  }

  toV10Schema(): SecuritySchemeV10 {
    return {
      openIdConnectSecurityScheme: {
        openIdConnectUrl: this.openIdConnectUrl,
        ...(this.description ? { description: this.description } : {}),
      },
    };
  }

  async authenticate(context: RequestContext): Promise<AuthResult> {
    if (!this._validator) {
      return { authenticated: true };
    }

    const token = this._extractBearerToken(context);
    if (!token) {
      return {
        authenticated: false,
        error: 'Missing Bearer token in Authorization header',
      };
    }

    return this._validator(token);
  }

  private _extractBearerToken(context: RequestContext): string | undefined {
    const authHeader = this.getHeader(context, 'authorization');
    if (!authHeader) return undefined;

    const parts = authHeader.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== 'bearer') {
      return undefined;
    }
    return parts[1];
  }
}
