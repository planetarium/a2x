/**
 * Client - public API for communicating with remote A2A agents.
 */

export { A2XClient } from './a2x-client.js';
export type { A2XClientOptions } from './a2x-client.js';

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
