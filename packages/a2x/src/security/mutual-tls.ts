/**
 * Layer 1: MutualTlsAuthorization security scheme.
 */

import type { SecuritySchemeV03, SecuritySchemeV10 } from '../types/security.js';
import { BaseSecurityScheme } from './base.js';

export interface MutualTlsAuthorizationOptions {
  description?: string;
}

export class MutualTlsAuthorization extends BaseSecurityScheme {
  constructor(options?: MutualTlsAuthorizationOptions) {
    super(options?.description);
  }

  toV03Schema(): SecuritySchemeV03 {
    return {
      type: 'mutualTLS',
      ...(this.description ? { description: this.description } : {}),
    };
  }

  toV10Schema(): SecuritySchemeV10 {
    return {
      mtlsSecurityScheme: {
        ...(this.description ? { description: this.description } : {}),
      },
    };
  }
}
