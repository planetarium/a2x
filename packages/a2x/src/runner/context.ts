/**
 * Layer 2: InvocationContext and Session types.
 */

import type { AgentEvent } from '../agent/base-agent.js';
import type { BasePlugin } from '../plugin/base-plugin.js';
import type { InputRoundTripContext } from '../a2x/input-roundtrip.js';

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
  /**
   * Populated only on resume turns of a task that previously emitted a
   * `request-input` AgentEvent. Carries (a) the `InputRoundTripRecord`
   * the agent emitted on the prior turn, (b) the optional outcome a
   * registered hook produced when handling the resume message (e.g. x402
   * verify+settle ran here), and (c) the raw resume-message metadata.
   *
   * Domain helpers (e.g. `readX402Settlement`) read this surface; agent
   * authors using a custom domain can read `input.previous.payload` and
   * `input.resumeMetadata` directly.
   */
  input?: InputRoundTripContext;
}
