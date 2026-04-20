/**
 * Layer 1: SecurityScheme related types for v0.3 and v1.0 AgentCard output.
 */

// ─── SecurityRequirement (OR-of-ANDs) ───

/** Internal / v0.3 format: flat Record<string, string[]> */
export type SecurityRequirement = Record<string, string[]>;

/** v1.0 wire format: wrapped { schemes: { name: { values: string[] } } } */
export interface SecurityRequirementV10 {
  schemes: Record<string, { values: string[] }>;
}

// ─── v0.3 SecurityScheme Types ───

export type SecuritySchemeV03 =
  | { type: 'apiKey'; in: string; name: string; description?: string }
  | { type: 'http'; scheme: string; bearerFormat?: string; description?: string }
  | { type: 'oauth2'; flows: OAuthFlowsV03; description?: string; oauth2MetadataUrl?: string }
  | { type: 'openIdConnect'; openIdConnectUrl: string; description?: string }
  | { type: 'mutualTLS'; description?: string };

export interface OAuthFlowsV03 {
  authorizationCode?: AuthorizationCodeFlowV03;
  clientCredentials?: ClientCredentialsFlowV03;
  /**
   * Non-standard extension: OpenAPI 3.0 (and therefore A2A v0.3) does not define
   * a `deviceCode` flow. `@a2x/sdk` emits and consumes this key to bridge the
   * compatibility gap for headless/CLI clients that still talk to v0.3 peers.
   * Third-party v0.3 implementations may ignore an unknown flow.
   */
  deviceCode?: DeviceCodeFlowV03;
  implicit?: ImplicitFlowV03;
  password?: PasswordFlowV03;
}

export interface AuthorizationCodeFlowV03 {
  authorizationUrl: string;
  tokenUrl: string;
  scopes: Record<string, string>;
  refreshUrl?: string;
}

export interface ClientCredentialsFlowV03 {
  tokenUrl: string;
  scopes: Record<string, string>;
  refreshUrl?: string;
}

export interface DeviceCodeFlowV03 {
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  scopes: Record<string, string>;
  refreshUrl?: string;
}

export interface ImplicitFlowV03 {
  authorizationUrl: string;
  scopes: Record<string, string>;
  refreshUrl?: string;
}

export interface PasswordFlowV03 {
  tokenUrl: string;
  scopes: Record<string, string>;
  refreshUrl?: string;
}

// ─── v1.0 SecurityScheme Types ───

export interface SecuritySchemeV10 {
  apiKeySecurityScheme?: ApiKeySchemeV10;
  httpAuthSecurityScheme?: HttpAuthSchemeV10;
  oauth2SecurityScheme?: OAuth2SchemeV10;
  openIdConnectSecurityScheme?: OpenIdConnectSchemeV10;
  mtlsSecurityScheme?: MutualTlsSchemeV10;
}

export interface ApiKeySchemeV10 {
  location: string;
  name: string;
  description?: string;
}

export interface HttpAuthSchemeV10 {
  scheme: string;
  bearerFormat?: string;
  description?: string;
}

export interface OAuth2SchemeV10 {
  flows: OAuthFlowsV10;
  description?: string;
}

export interface OAuthFlowsV10 {
  authorizationCode?: AuthorizationCodeFlowV10;
  clientCredentials?: ClientCredentialsFlowV10;
  deviceCode?: DeviceCodeFlowV10;
  implicit?: ImplicitFlowV10;
  password?: PasswordFlowV10;
}

export interface AuthorizationCodeFlowV10 {
  authorizationUrl: string;
  tokenUrl: string;
  scopes: Record<string, string>;
  refreshUrl?: string;
  pkceRequired?: boolean;
}

export interface ClientCredentialsFlowV10 {
  tokenUrl: string;
  scopes: Record<string, string>;
  refreshUrl?: string;
}

export interface DeviceCodeFlowV10 {
  deviceAuthorizationUrl: string;
  tokenUrl: string;
  scopes: Record<string, string>;
  refreshUrl?: string;
}

export interface ImplicitFlowV10 {
  authorizationUrl: string;
  scopes: Record<string, string>;
  refreshUrl?: string;
}

export interface PasswordFlowV10 {
  tokenUrl: string;
  scopes: Record<string, string>;
  refreshUrl?: string;
}

export interface OpenIdConnectSchemeV10 {
  openIdConnectUrl: string;
  description?: string;
}

export interface MutualTlsSchemeV10 {
  description?: string;
}
