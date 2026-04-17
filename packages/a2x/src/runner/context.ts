/**
 * Layer 2: InvocationContext and Session types.
 */

import type { AgentEvent } from '../agent/base-agent.js';
import type { BasePlugin } from '../plugin/base-plugin.js';

// ─── Session ───

export interface Session {
  id: string;
  appName: string;
  userId?: string;
  state: Record<string, unknown>;
  events: AgentEvent[];
  createdAt: string;
  updatedAt: string;
}

// ─── InvocationContext ───

export interface InvocationContext {
  session: Session;
  state: Record<string, unknown>; // proxy to session.state
  agentName: string;
  plugins?: BasePlugin[];
  maxLlmCalls?: number;
  signal?: AbortSignal;
}
