/**
 * Layer 1: OAuth2ClientCredentialsAuthorization security scheme.
 */

import type {
  ClientCredentialsFlowV03,
  ClientCredentialsFlowV10,
  SecuritySchemeV03,
  SecuritySchemeV10,
} from '../types/security.js';
import { BaseSecurityScheme } from './base.js';

export interface OAuth2ClientCredentialsAuthorizationOptions {
  tokenUrl: string;
  scopes: Record<string, string>;
  refreshUrl?: string;
  description?: string;
}

export class OAuth2ClientCredentialsAuthorization extends BaseSecurityScheme {
  readonly tokenUrl: string;
  readonly scopes: Record<string, string>;
  readonly refreshUrl?: string;

  constructor(options: OAuth2ClientCredentialsAuthorizationOptions) {
    super(options.description);
    this.validateRequired(
      { tokenUrl: options.tokenUrl, scopes: options.scopes },
      'OAuth2ClientCredentialsAuthorization',
    );
    this.tokenUrl = options.tokenUrl;
    this.scopes = options.scopes;
    this.refreshUrl = options.refreshUrl;
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
}
