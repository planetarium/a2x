/**
 * Layer 1: MutualTlsAuthorization security scheme.
 */

import type { SecuritySchemeV03, SecuritySchemeV10 } from '../types/security.js';
import type { RequestContext, AuthResult, ClientCertificate } from '../types/auth.js';
import { BaseSecurityScheme } from './base.js';

export interface MutualTlsAuthorizationOptions {
  description?: string;
  /** List of trusted client certificate fingerprints. */
  trustedFingerprints?: string[];
  /** Custom certificate validator. Takes precedence over `trustedFingerprints`. */
  validator?: (cert: ClientCertificate) => Promise<AuthResult> | AuthResult;
}

export class MutualTlsAuthorization extends BaseSecurityScheme {
  private readonly _trustedFingerprints?: string[];
  private readonly _validator?: (cert: ClientCertificate) => Promise<AuthResult> | AuthResult;

  constructor(options?: MutualTlsAuthorizationOptions) {
    super(options?.description);
    this._trustedFingerprints = options?.trustedFingerprints;
    this._validator = options?.validator;
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

  async authenticate(context: RequestContext): Promise<AuthResult> {
    // No validation config → pass-through
    if (!this._trustedFingerprints && !this._validator) {
      return { authenticated: true };
    }

    const cert = context.clientCertificate;
    if (!cert) {
      return {
        authenticated: false,
        error: 'Missing client certificate',
      };
    }

    // Custom validator takes precedence
    if (this._validator) {
      return this._validator(cert);
    }

    // Built-in fingerprint check
    if (this._trustedFingerprints) {
      if (cert.fingerprint && this._trustedFingerprints.includes(cert.fingerprint)) {
        return { authenticated: true, principal: { fingerprint: cert.fingerprint } };
      }
      return {
        authenticated: false,
        error: 'Client certificate fingerprint not trusted',
      };
    }

    return { authenticated: true };
  }
}
