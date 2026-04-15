/**
 * Layer 1: OAuth2ClientCredentialsAuthorization security scheme.
 */

import type {
  ClientCredentialsFlowV03,
  ClientCredentialsFlowV10,
  SecuritySchemeV03,
  SecuritySchemeV10,
} from '../types/security.js';
import type { RequestContext, AuthResult } from '../types/auth.js';
import { BaseSecurityScheme } from './base.js';

export interface OAuth2ClientCredentialsAuthorizationOptions {
  tokenUrl: string;
  scopes: Record<string, string>;
  refreshUrl?: string;
  description?: string;
  /**
   * Token validator callback. Receives the bearer token and required scopes.
   */
  tokenValidator?: (
    token: string,
    requiredScopes: string[],
  ) => Promise<AuthResult> | AuthResult;
}

export class OAuth2ClientCredentialsAuthorization extends BaseSecurityScheme {
  readonly tokenUrl: string;
  readonly scopes: Record<string, string>;
  readonly refreshUrl?: string;
  private readonly _tokenValidator?: (
    token: string,
    requiredScopes: string[],
  ) => Promise<AuthResult> | AuthResult;

  constructor(options: OAuth2ClientCredentialsAuthorizationOptions) {
    super(options.description);
    this.validateRequired(
      { tokenUrl: options.tokenUrl, scopes: options.scopes },
      'OAuth2ClientCredentialsAuthorization',
    );
    this.tokenUrl = options.tokenUrl;
    this.scopes = options.scopes;
    this.refreshUrl = options.refreshUrl;
    this._tokenValidator = options.tokenValidator;
  }

  toV03Schema(): SecuritySchemeV03 {
    const flow: ClientCredentialsFlowV03 = {
      tokenUrl: this.tokenUrl,
      scopes: this.scopes,
      ...(this.refreshUrl ? { refreshUrl: this.refreshUrl } : {}),
    };

    return {
      type: 'oauth2',
      flows: { clientCredentials: flow },
      ...(this.description ? { description: this.description } : {}),
    };
  }

  toV10Schema(): SecuritySchemeV10 {
    const flow: ClientCredentialsFlowV10 = {
      tokenUrl: this.tokenUrl,
      scopes: this.scopes,
      ...(this.refreshUrl ? { refreshUrl: this.refreshUrl } : {}),
    };

    return {
      oauth2SecurityScheme: {
        flows: { clientCredentials: flow },
        ...(this.description ? { description: this.description } : {}),
      },
    };
  }

  async authenticate(
    context: RequestContext,
    requiredScopes: string[] = [],
  ): Promise<AuthResult> {
    if (!this._tokenValidator) {
      return { authenticated: true };
    }

    const token = this._extractBearerToken(context);
    if (!token) {
      return {
        authenticated: false,
        error: 'Missing Bearer token in Authorization header',
      };
    }

    return this._tokenValidator(token, requiredScopes);
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
