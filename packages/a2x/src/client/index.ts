/**
 * Client - public API for communicating with remote A2A agents.
 */

export { A2XClient } from './a2x-client.js';
export type {
  A2XClientOptions,
  A2XClientX402Options,
} from './a2x-client.js';

export {
  resolveAgentCard,
  detectProtocolVersion,
  getAgentEndpointUrl,
  AGENT_CARD_WELL_KNOWN_PATH,
  AGENT_CARD_WELL_KNOWN_PATH_ALT,
} from './agent-card-resolver.js';
export type {
  AgentCardResolverOptions,
  ResolvedAgentCard,
} from './agent-card-resolver.js';

export { getResponseParser } from './response-parser.js';
export type { ResponseParser } from './response-parser.js';

export { parseSSEStream } from './sse-parser.js';

export type { AuthProvider } from './auth-provider.js';
export type { AuthRequestContext } from './auth-scheme.js';
export {
  AuthScheme,
  ApiKeyAuthScheme,
  HttpBearerAuthScheme,
  HttpBasicAuthScheme,
  OAuth2DeviceCodeAuthScheme,
  OAuth2AuthorizationCodeAuthScheme,
  OAuth2ClientCredentialsAuthScheme,
  OAuth2ImplicitAuthScheme,
  OAuth2PasswordAuthScheme,
  OpenIdConnectAuthScheme,
} from './auth-scheme.js';
export { normalizeRequirements, normalizeScheme } from './auth-normalizer.js';
