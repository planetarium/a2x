/**
 * Client - public API for communicating with remote A2A agents.
 */

export { A2XClient } from './a2x-client.js';
export type {
  A2XClientOptions,
  A2XClientX402Options,
} from './a2x-client.js';

// Type-only, so this does not pull the x402 runtime peers into this entry.
// Re-exported because `A2XClientX402Options.batchSettlement` and `.upto` are
// otherwise unnameable from `@a2x/sdk/client`.
export type {
  X402UptoOptions,
  X402UptoSchemeConfig,
  X402BatchSettlementOptions,
  X402BatchSettlementDepositPolicy,
  X402BatchSettlementDepositStrategy,
  X402BatchSettlementDepositContext,
  X402BatchSettlementBinding,
  X402BatchSettlementPayloadBinding,
  X402ClientChannelStorage,
  X402ChannelState,
} from '../x402/client.js';

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
