/**
 * Client-side AgentCard resolution and protocol version detection.
 */

import type { AgentCardV03, AgentCardV10 } from '../types/agent-card.js';
import type { ProtocolVersion } from '../a2x/a2x-agent.js';
import type { AgentInterfaceV10 } from '../types/agent-card.js';
import type { A2ATransport } from '../types/transport.js';
import { A2A_TRANSPORTS } from '../types/transport.js';

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

export interface SelectedAgentInterface {
  url: string;
  binding: A2ATransport;
  protocolVersion: ProtocolVersion;
  tenant?: string;
}

// ─── Protocol Version Detection ───

/**
 * Detect whether an AgentCard is v0.3 or v1.0.
 *
 * Per spec, the card's own `protocolVersion` is authoritative:
 *   - v0.3 (`a2a-v0.3.0.json`) requires a top-level `protocolVersion` (full semver, e.g. "0.3.0").
 *   - v1.0 (`a2a-v1.0.0.json`) has no top-level `protocolVersion`; versions appear per-interface.
 *
 * Shape alone is ambiguous: a v0.3 agent may legally also expose `supportedInterfaces` to
 * advertise additional transports, and would be misclassified as v1.0 if we ignored the
 * declared version. Honor the declared field first, then fall back to shape heuristics.
 */
export function detectProtocolVersion(card: Record<string, unknown>): ProtocolVersion {
  const declared = card.protocolVersion;
  if (typeof declared === 'string') {
    if (declared.startsWith('0.3')) return '0.3';
    if (declared.startsWith('1.')) return '1.0';
  }
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
 * Select an endpoint whose binding the client actually implements.
 */
export function selectAgentInterface(
  card: AgentCardV03 | AgentCardV10,
  version: ProtocolVersion,
  preferredTransports: readonly A2ATransport[] = [
    A2A_TRANSPORTS.JSONRPC,
    A2A_TRANSPORTS.HTTP_JSON,
  ],
): SelectedAgentInterface {
  if (version === '0.3') {
    const v03 = card as AgentCardV03;
    if (!v03.url) {
      throw new Error('v0.3 AgentCard missing required "url" field');
    }
    const preferred = (v03.preferredTransport ?? 'JSONRPC').toUpperCase();
    if (preferred !== A2A_TRANSPORTS.JSONRPC) {
      throw new Error(
        `Unsupported v0.3 A2A transport '${v03.preferredTransport}'. ` +
          'Only JSONRPC is implemented for v0.3 cards.',
      );
    }
    return {
      url: v03.url,
      binding: A2A_TRANSPORTS.JSONRPC,
      protocolVersion: '0.3',
    };
  }

  const v10 = card as AgentCardV10;
  if (!v10.supportedInterfaces || v10.supportedInterfaces.length === 0) {
    throw new Error('v1.0 AgentCard has no supportedInterfaces');
  }

  for (const binding of preferredTransports) {
    const iface = v10.supportedInterfaces.find(
      (candidate) =>
        normalizeBinding(candidate) === binding &&
        normalizeProtocolVersion(candidate.protocolVersion) === '1.0',
    );
    if (iface) {
      return {
        url: iface.url,
        binding,
        protocolVersion: '1.0',
        ...(iface.tenant ? { tenant: iface.tenant } : {}),
      };
    }
  }

  const advertised = v10.supportedInterfaces
    .map((i) => `${i.protocolBinding}@${i.protocolVersion}`)
    .join(', ');
  throw new Error(
    `AgentCard has no supported A2A transport interface. ` +
      `Client supports: ${preferredTransports.join(', ')}; agent advertises: ${advertised}`,
  );
}

function normalizeProtocolVersion(value: string | undefined): ProtocolVersion | undefined {
  if (value?.startsWith('0.3')) return '0.3';
  if (value?.startsWith('1.')) return '1.0';
  return undefined;
}

/**
 * Extract an endpoint URL using the default client transport preference.
 * Kept for compatibility; use selectAgentInterface() when the binding matters.
 */
export function getAgentEndpointUrl(
  card: AgentCardV03 | AgentCardV10,
  version: ProtocolVersion,
): string {
  return selectAgentInterface(card, version).url;
}

function normalizeBinding(iface: AgentInterfaceV10): A2ATransport | undefined {
  const value = iface.protocolBinding?.toUpperCase();
  if (value === A2A_TRANSPORTS.JSONRPC) return A2A_TRANSPORTS.JSONRPC;
  if (value === A2A_TRANSPORTS.HTTP_JSON || value === 'REST') {
    return A2A_TRANSPORTS.HTTP_JSON;
  }
  return undefined;
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
