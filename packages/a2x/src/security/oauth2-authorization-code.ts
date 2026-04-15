/**
 * Layer 1: OAuth2AuthorizationCodeAuthorization security scheme.
 */

import type {
  AuthorizationCodeFlowV03,
  AuthorizationCodeFlowV10,
  SecuritySchemeV03,
  SecuritySchemeV10,
} from '../types/security.js';
import type { RequestContext, AuthResult } from '../types/auth.js';
import { BaseSecurityScheme } from './base.js';

export interface OAuth2AuthorizationCodeAuthorizationOptions {
  authorizationUrl: string;
  tokenUrl: string;
  scopes: Record<string, string>;
  refreshUrl?: string;
  pkceRequired?: boolean;
  description?: string;
  /**
   * Token validator callback. Receives the bearer token and required scopes.
   * Use this for custom token validation (introspection, opaque tokens, etc.).
   */
  tokenValidator?: (
    token: string,
    requiredScopes: string[],
  ) => Promise<AuthResult> | AuthResult;
}

export class OAuth2AuthorizationCodeAuthorization extends BaseSecurityScheme {
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: Record<string, string>;
  readonly refreshUrl?: string;
  readonly pkceRequired?: boolean;
  private readonly _tokenValidator?: (
    token: string,
    requiredScopes: string[],
  ) => Promise<AuthResult> | AuthResult;

  constructor(options: OAuth2AuthorizationCodeAuthorizationOptions) {
    super(options.description);
    this.validateRequired(
      {
        authorizationUrl: options.authorizationUrl,
        tokenUrl: options.tokenUrl,
        scopes: options.scopes,
      },
      'OAuth2AuthorizationCodeAuthorization',
    );
    this.authorizationUrl = options.authorizationUrl;
    this.tokenUrl = options.tokenUrl;
    this.scopes = options.scopes;
    this.refreshUrl = options.refreshUrl;
    this.pkceRequired = options.pkceRequired;
    this._tokenValidator = options.tokenValidator;
  }

  toV03Schema(): SecuritySchemeV03 {
    const flow: AuthorizationCodeFlowV03 = {
      authorizationUrl: this.authorizationUrl,
      tokenUrl: this.tokenUrl,
      scopes: this.scopes,
      ...(this.refreshUrl ? { refreshUrl: this.refreshUrl } : {}),
    };

    return {
      type: 'oauth2',
      flows: { authorizationCode: flow },
      ...(this.description ? { description: this.description } : {}),
    };
  }

  toV10Schema(): SecuritySchemeV10 {
    const flow: AuthorizationCodeFlowV10 = {
      authorizationUrl: this.authorizationUrl,
      tokenUrl: this.tokenUrl,
      scopes: this.scopes,
      ...(this.refreshUrl ? { refreshUrl: this.refreshUrl } : {}),
      ...(this.pkceRequired !== undefined
        ? { pkceRequired: this.pkceRequired }
        : {}),
    };

    return {
      oauth2SecurityScheme: {
        flows: { authorizationCode: flow },
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
