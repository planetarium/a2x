/**
 * Layer 1: OAuth2DeviceCodeAuthorization security scheme.
 *
 * A2A v0.3 (OpenAPI 3.0 based) does not standardize a deviceCode flow, but
 * also does not prohibit vendor extensions inside `oauth2.flows`. toV03Schema()
 * emits `deviceCode` as a non-standard extension so `@a2x/sdk` clients can
 * negotiate the flow against v0.3 peers. Strict third-party parsers will
 * typically ignore the unknown flow and fall back to other configured flows.
 */

import type {
  DeviceCodeFlowV03,
  DeviceCodeFlowV10,
  SecuritySchemeV03,
  SecuritySchemeV10,
} from '../types/security.js';
import type { RequestContext, AuthResult } from '../types/auth.js';
import { BaseSecurityScheme } from './base.js';

export interface OAuth2DeviceCodeAuthorizationOptions {
  deviceAuthorizationUrl: string;
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

export class OAuth2DeviceCodeAuthorization extends BaseSecurityScheme {
  readonly deviceAuthorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: Record<string, string>;
  readonly refreshUrl?: string;
  private readonly _tokenValidator?: (
    token: string,
    requiredScopes: string[],
  ) => Promise<AuthResult> | AuthResult;

  constructor(options: OAuth2DeviceCodeAuthorizationOptions) {
    super(options.description);
    this.validateRequired(
      {
        deviceAuthorizationUrl: options.deviceAuthorizationUrl,
        tokenUrl: options.tokenUrl,
        scopes: options.scopes,
      },
      'OAuth2DeviceCodeAuthorization',
    );
    this.deviceAuthorizationUrl = options.deviceAuthorizationUrl;
    this.tokenUrl = options.tokenUrl;
    this.scopes = options.scopes;
    this.refreshUrl = options.refreshUrl;
    this._tokenValidator = options.tokenValidator;
  }

  /**
   * Emits the Device Code flow on a v0.3 AgentCard as a non-standard extension.
   * OpenAPI 3.0 does not define `oauth2.flows.deviceCode`, so strict third-party
   * v0.3 parsers may ignore this flow. `@a2x/sdk` clients consume it natively.
   */
  toV03Schema(): SecuritySchemeV03 {
    const flow: DeviceCodeFlowV03 = {
      deviceAuthorizationUrl: this.deviceAuthorizationUrl,
      tokenUrl: this.tokenUrl,
      scopes: this.scopes,
      ...(this.refreshUrl ? { refreshUrl: this.refreshUrl } : {}),
    };
    return {
      type: 'oauth2',
      flows: { deviceCode: flow },
      ...(this.description ? { description: this.description } : {}),
    };
  }

  toV10Schema(): SecuritySchemeV10 {
    const flow: DeviceCodeFlowV10 = {
      deviceAuthorizationUrl: this.deviceAuthorizationUrl,
      tokenUrl: this.tokenUrl,
      scopes: this.scopes,
      ...(this.refreshUrl ? { refreshUrl: this.refreshUrl } : {}),
    };

    return {
      oauth2SecurityScheme: {
        flows: { deviceCode: flow },
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
