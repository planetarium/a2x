/**
 * Input-required round-trip primitives.
 *
 * Built on top of the `request-input` AgentEvent variant (see
 * `agent/base-agent.ts`), this module defines the small set of types the
 * default `AgentExecutor` uses to coordinate first-turn / resume-turn
 * lifecycles and the optional hooks domain helpers (x402 / approval /
 * OAuth / etc.) register to handle the resume side.
 *
 * The SDK core stays domain-agnostic: this file defines no x402 specifics
 * and never imports x402 types. Domain modules supply hooks that mutate
 * the `InputRoundTripOutcome` shape; the executor applies the outcome
 * uniformly regardless of domain.
 */

import type { Message } from '../types/common.js';

/**
 * Bookkeeping the default `AgentExecutor` writes onto an input-required
 * task and reads back on the resume turn. The agent's emitted `metadata`
 * goes on the wire under `task.status.message.metadata` as-is, while this
 * record is stashed under a private key (`_a2x.inputRoundTrip`) so it
 * survives across restarts via the same `TaskStore` that persists the
 * task itself.
 */
export interface InputRoundTripRecord {
  /** Domain key the agent supplied on the first turn (e.g. `'x402'`). */
  domain: string;
  /**
   * Implementation-defined opaque value the agent supplied on the first
   * turn. Round-tripped verbatim — the SDK does not interpret it.
   */
  payload?: unknown;
  /** Wire metadata the agent emitted on the first turn (verbatim). */
  emittedMetadata: Record<string, unknown>;
  /** ISO timestamp of the first turn's emission. */
  emittedAt: string;
}

/**
 * Outcome a registered `InputRoundTripHook` produces on a resume turn.
 *
 * The default `AgentExecutor` interprets each field uniformly:
 *
 *  - `terminate`        — end the task immediately with the given state.
 *  - `reissueInputRequired` — re-publish input-required (e.g. x402
 *    `retryOnFailure`) instead of running the agent again.
 *  - `intermediate`     — emit one transient working-state status update
 *    between the hook running and the agent running again.
 *  - `data`             — surfaced via `InvocationContext.input.outcome.data`
 *    so the resume-turn agent can branch on it.
 *  - `finalMetadataPatch` — merged into the agent's final task message
 *    metadata after the second-turn run completes.
 */
export interface InputRoundTripOutcome {
  /** True when the hook handled the resume successfully and wants the agent to run again. */
  resumed: boolean;
  /**
   * When set, the SDK terminates the task immediately with the provided
   * status (e.g. payment-rejected → terminal failed). The agent does not
   * run again.
   */
  terminate?: {
    state: 'failed' | 'rejected';
    reason?: string;
    metadata?: Record<string, unknown>;
  };
  /**
   * Domain-specific data the agent reads back. For x402 this is
   * `{ paid: true, receipt: X402SettleResponse }`.
   */
  data?: Record<string, unknown>;
  /**
   * Metadata to merge into the *final* completed task's
   * `status.message.metadata` (after the agent's second-turn run finishes).
   * For x402 this is `{ 'x402.payment.status': 'payment-completed',
   * 'x402.payment.receipts': [...] }`.
   */
  finalMetadataPatch?: Record<string, unknown>;
  /**
   * Optional intermediate status update the SDK should emit between the
   * resume hook running and the agent running again. For x402 this is the
   * transient `payment-verified` working-state event (spec §7.1).
   */
  intermediate?: {
    state: 'working';
    metadata: Record<string, unknown>;
  };
  /**
   * When set, the SDK re-issues `input-required` with this metadata
   * instead of running the agent. Used by x402 `retryOnFailure` (spec §9):
   * verify/settle failed → re-prompt for payment, don't terminate.
   *
   * `payload` carries forward to the next round-trip's record so the
   * agent's first-turn payload (e.g. `{ accepts: [...] }`) is not lost.
   */
  reissueInputRequired?: {
    metadata: Record<string, unknown>;
    payload?: unknown;
  };
}

/**
 * Hook the agent (or domain helper module) registers for a particular
 * `domain`. The default `AgentExecutor` consults this registry on resume
 * turns and runs the hook to produce the outcome.
 */
export interface InputRoundTripHook {
  /** Stable identifier matching the agent's emitted `event.domain`. */
  domain: string;
  /**
   * Called on a resume turn. Receives the resume message + the previous
   * round-trip's record. Returns the outcome the SDK should apply.
   *
   * Implementations may call out to external systems (facilitator,
   * approval service, OAuth introspection) here.
   */
  handleResume(input: {
    message: Message;
    previous: InputRoundTripRecord;
    signal?: AbortSignal;
  }): Promise<InputRoundTripOutcome>;
}

/**
 * Round-trip context surfaced on the second-turn `InvocationContext`.
 * `previous` is always present when this struct is set; `outcome` is set
 * iff a hook was registered for `previous.domain` and ran successfully.
 */
export interface InputRoundTripContext {
  previous: InputRoundTripRecord;
  outcome?: InputRoundTripOutcome;
  /**
   * Raw resume message metadata. Useful when the agent wants to inspect
   * what the client sent without going through the hook (or when no hook
   * is registered for the domain).
   */
  resumeMetadata: Record<string, unknown>;
}

/**
 * Private metadata key the SDK uses to stash the round-trip record on
 * `task.status.message.metadata`. Wire-visible (clients can read it) but
 * not part of any spec — clients that don't recognize it ignore it per
 * A2A's open-metadata convention. The leading underscore + dotted scope
 * matches the SDK's internal-bookkeeping convention.
 */
export const INPUT_ROUNDTRIP_METADATA_KEY = '_a2x.inputRoundTrip' as const;
