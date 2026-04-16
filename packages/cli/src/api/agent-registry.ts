/**
 * REST API client for the Agent Registry service.
 *
 * Provides functions for searching and registering agents.
 * Uses native fetch with AbortController for timeout management.
 */

const REQUEST_TIMEOUT_MS = 10_000;

/** Minimal agent representation returned from search results. */
export interface AgentSummary {
  name: string;
  description: string;
  agentCardUrl: string;
}

/** Shape of the search API response body. */
interface SearchResponse {
  results: AgentSummary[];
}

/**
 * Search for agents in the registry.
 *
 * @param registryUrl - Base URL of the Agent Registry service.
 * @param query - Optional free-text search string. When omitted, returns recent agents.
 * @param limit - Maximum number of results. Defaults to 10.
 * @returns Array of matching agent summaries.
 * @throws Error on network failure, timeout, or non-2xx HTTP response.
 */
export async function searchAgents(
  registryUrl: string,
  query?: string,
  limit = 10,
): Promise<AgentSummary[]> {
  const url = new URL('/api/agents/search', registryUrl);
  if (query) url.searchParams.set('q', query);
  url.searchParams.set('limit', String(limit));

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, { signal: controller.signal });

    if (!res.ok) {
      throw await buildHttpError(res);
    }

    const body = (await res.json()) as SearchResponse;
    return body.results;
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Registry request timed out after 10s');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Register an agent in the registry by its Agent Card URL.
 *
 * @param registryUrl - Base URL of the Agent Registry service.
 * @param agentCardUrl - URL pointing to the agent's Agent Card JSON.
 * @returns The raw response body from the registry (structure varies).
 * @throws Error on network failure, timeout, or non-2xx HTTP response.
 */
export async function registerAgent(
  registryUrl: string,
  agentCardUrl: string,
): Promise<unknown> {
  const url = new URL('/api/agents', registryUrl);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentCardUrl }),
      signal: controller.signal,
    });

    if (!res.ok) {
      throw await buildHttpError(res);
    }

    return await res.json();
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('Registry request timed out after 10s');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Build a descriptive Error from a non-2xx HTTP response.
 * Attempts to extract an error message from the response body.
 */
async function buildHttpError(res: Response): Promise<Error> {
  let detail = `Registry returned HTTP ${res.status}`;
  try {
    const body = (await res.json()) as Record<string, unknown>;
    if (body.error) detail += `: ${body.error}`;
    else if (body.message) detail += `: ${body.message}`;
  } catch {
    /* ignore parse failure */
  }
  return new Error(detail);
}
