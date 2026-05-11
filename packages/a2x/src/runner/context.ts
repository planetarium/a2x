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
   * A2A `Task.id` of the current turn (wire-protocol identifier). Stable
   * across the `request-input` → resume cycle: the first turn and every
   * resume turn of the same task see the same value. Set by the default
   * `AgentExecutor` when dispatching under an A2A task; undefined when
   * the Runner is used standalone (no enclosing A2A task).
   *
   * Prefer this over `session.id` for scoping per-task durable state
   * (paid rows, approval tokens, …) — `session.id` is regenerated on
   * every invocation and is not safe to bind state to across turns.
   */
  taskId?: string;
  /**
   * A2A `contextId` of the current turn (wire-protocol identifier). One
   * `contextId` umbrellas many tasks in the same conversation (1:N), so
   * this is the right key for state that should outlive a single task
   * but stay scoped to one conversation. Set by the default
   * `AgentExecutor` when dispatching under an A2A task; undefined when
   * the Runner is used standalone.
   */
  contextId?: string;
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
