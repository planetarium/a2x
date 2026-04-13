/**
 * Layer 1: OpenIdConnectAuthorization security scheme.
 */

import type { SecuritySchemeV03, SecuritySchemeV10 } from '../types/security.js';
import { BaseSecurityScheme } from './base.js';

export interface OpenIdConnectAuthorizationOptions {
  openIdConnectUrl: string;
  description?: string;
}

export class OpenIdConnectAuthorization extends BaseSecurityScheme {
  readonly openIdConnectUrl: string;

  constructor(options: OpenIdConnectAuthorizationOptions) {
    super(options.description);
    this.validateRequired(
      { openIdConnectUrl: options.openIdConnectUrl },
      'OpenIdConnectAuthorization',
    );
    this.openIdConnectUrl = options.openIdConnectUrl;
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
}
