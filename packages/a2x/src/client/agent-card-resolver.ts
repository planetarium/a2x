/**
 * Client-side AgentCard resolution and protocol version detection.
 */

import type { AgentCardV03, AgentCardV10 } from '../types/agent-card.js';
import type { ProtocolVersion } from '../a2x/a2x-agent.js';

export type { ProtocolVersion };

// ─── Constants ───

export const AGENT_CARD_WELL_KNOWN_PATH = '/.well-known/agent.json';
export const AGENT_CARD_WELL_KNOWN_PATH_ALT = '/.well-known/agent-card.json';

const WELL_KNOWN_PATHS = [
  AGENT_CARD_WELL_KNOWN_PATH,
  AGENT_CARD_WELL_KNOWN_PATH_ALT,
] as const;

// ─── Types ───

export interface AgentCardResolverOptions {
  fetch?: typeof globalThis.fetch;
  headers?: Record<string, string>;
  path?: string;
}

export interface ResolvedAgentCard {
  card: AgentCardV03 | AgentCardV10;
  version: ProtocolVersion;
  baseUrl: string;
}

// ─── Protocol Version Detection ───

/**
 * Detect whether an AgentCard is v0.3 or v1.0.
 *
 * v0.3 cards have a top-level `url` field and `protocolVersion` string.
 * v1.0 cards have a `supportedInterfaces` array.
 */
export function detectProtocolVersion(card: Record<string, unknown>): ProtocolVersion {
  if (
    Array.isArray(card.supportedInterfaces) &&
    card.supportedInterfaces.length > 0
  ) {
    return '1.0';
  }
  if (typeof card.url === 'string') {
    return '0.3';
  }
  // Default to 1.0 if structure is ambiguous
  return '1.0';
}

// ─── Endpoint URL Extraction ───

/**
 * Extract the JSON-RPC endpoint URL from a resolved AgentCard.
 */
export function getAgentEndpointUrl(
  card: AgentCardV03 | AgentCardV10,
  version: ProtocolVersion,
): string {
  if (version === '0.3') {
    const v03 = card as AgentCardV03;
    if (!v03.url) {
      throw new Error('v0.3 AgentCard missing required "url" field');
    }
    return v03.url;
  }

  const v10 = card as AgentCardV10;
  if (!v10.supportedInterfaces || v10.supportedInterfaces.length === 0) {
    throw new Error('v1.0 AgentCard has no supportedInterfaces');
  }

  // Prefer JSONRPC binding
  const jsonRpcInterface = v10.supportedInterfaces.find(
    (i) => i.protocolBinding?.toUpperCase() === 'JSONRPC',
  );
  if (jsonRpcInterface) {
    return jsonRpcInterface.url;
  }

  // Fallback to first interface
  return v10.supportedInterfaces[0].url;
}

// ─── AgentCard Resolution ───

/**
 * Fetch and parse an AgentCard.
 *
 * Accepts three URL forms:
 *   1. Full URL ending in .json — fetches directly (e.g. http://host/.well-known/agent.json)
 *   2. Base URL + explicit path option — fetches baseUrl + path
 *   3. Base URL only — tries well-known paths in order:
 *        /.well-known/agent.json, /.well-known/agent-card.json
 */
export async function resolveAgentCard(
  url: string,
  options?: AgentCardResolverOptions,
): Promise<ResolvedAgentCard> {
  const fetchImpl = options?.fetch ?? globalThis.fetch;

  // Full URL to agent card (e.g. http://host:4000/.well-known/agent.json)
  if (!options?.path && url.endsWith('.json')) {
    const parsed = new URL(url);
    return fetchAgentCard(fetchImpl, parsed.origin, parsed.pathname, options?.headers);
  }

  const normalizedBase = url.replace(/\/+$/, '');

  // Explicit path provided
  if (options?.path) {
    return fetchAgentCard(fetchImpl, normalizedBase, options.path, options?.headers);
  }

  // Try well-known paths in order, return first success
  let lastError: Error | undefined;
  for (const path of WELL_KNOWN_PATHS) {
    try {
      return await fetchAgentCard(fetchImpl, normalizedBase, path, options?.headers);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }

  throw new Error(
    `Failed to fetch AgentCard from ${normalizedBase} ` +
    `(tried: ${WELL_KNOWN_PATHS.join(', ')}): ${lastError?.message}`,
  );
}

async function fetchAgentCard(
  fetchImpl: typeof globalThis.fetch,
  baseUrl: string,
  path: string,
  headers?: Record<string, string>,
): Promise<ResolvedAgentCard> {
  const cardUrl = `${baseUrl}${path}`;

  const response = await fetchImpl(cardUrl, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      ...headers,
    },
  });

  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}`,
    );
  }

  const card = (await response.json()) as Record<string, unknown>;
  const version = detectProtocolVersion(card);

  return {
    card: card as unknown as AgentCardV03 | AgentCardV10,
    version,
    baseUrl,
  };
}
