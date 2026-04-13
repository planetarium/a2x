/**
 * Layer 1: OAuth2DeviceCodeAuthorization security scheme.
 * Note: v0.3 does not support deviceCode flow. toV03Schema() returns null.
 */

import type {
  DeviceCodeFlowV10,
  SecuritySchemeV03,
  SecuritySchemeV10,
} from '../types/security.js';
import { BaseSecurityScheme } from './base.js';

export interface OAuth2DeviceCodeAuthorizationOptions {
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  scopes: Record<string, string>;
  refreshUrl?: string;
  description?: string;
}

export class OAuth2DeviceCodeAuthorization extends BaseSecurityScheme {
  readonly deviceAuthorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: Record<string, string>;
  readonly refreshUrl?: string;

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
  }

  /**
   * v0.3 does not support Device Code flow.
   * Returns null; the caller (Mapper) should exclude this scheme from v0.3 AgentCard.
   */
  toV03Schema(): SecuritySchemeV03 | null {
    console.warn(
      'OAuth2DeviceCodeAuthorization: Device Code flow is not supported in A2A v0.3. This scheme will be excluded from the v0.3 AgentCard.',
    );
    return null;
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
}
