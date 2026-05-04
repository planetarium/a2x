/**
 * Layer 2: BaseAgent abstract class.
 */

import type { InvocationContext } from '../runner/context.js';

// ─── AgentEvent (events yielded by agents to the Runner) ───

export type AgentEvent =
  | { type: 'text'; text: string; role?: 'user' | 'agent'; mediaType?: string }
  | {
    type: 'file';
    file: { raw?: string; url?: string; mediaType?: string; filename?: string };
  }
  | { type: 'data'; data: unknown; mediaType?: string }
  | { type: 'toolCall'; toolName: string; args: Record<string, unknown>; toolCallId?: string }
  | { type: 'toolResult'; toolName: string; result: unknown; toolCallId?: string }
  | {
    /**
     * Yielded by an agent to interrupt its run and ask the client for input
     * (most commonly a payment, an approval, or an external token). The
     * default `AgentExecutor` halts the agent generator on receipt, sets
     * `task.status = INPUT_REQUIRED`, merges `metadata` into the wire
     * status message metadata, and persists `payload` for the resume turn
     * via `InvocationContext.input.previous` (see runner/context.ts).
     */
    type: 'request-input';
    /**
     * Domain key the SDK uses to look up a registered hook (verify/settle
     * etc.). For x402 this is the canonical `'x402'` literal exported from
     * `@a2x/sdk/x402`. Custom domains supply their own.
     */
    domain: string;
    /**
     * Wire metadata that gets merged into the input-required task's
     * `status.message.metadata` as-is. The SDK does not interpret this
     * — it is the carrier (`x402.payment.required: { ... }`,
     * `myorg.approval.required: { ... }`, etc.).
     */
    metadata: Record<string, unknown>;
    /**
     * Human-readable status text shown on the input-required task's
     * `status.message.parts`. Optional.
     */
    message?: string;
    /**
     * Implementation-defined opaque value the agent wants to read back on
     * the resume turn. The SDK stores this on the task's status message
     * metadata under a private key and re-surfaces it via
     * `InvocationContext.input.previous.payload` so the agent doesn't need
     * to recompute "what did I ask for last time".
     *
     * Example for x402: `{ accepts: X402Accept[] }` so the resume-turn
     * agent can see the exact requirements it published.
     */
    payload?: unknown;
  }
  | { type: 'done'; output?: unknown }
  | { type: 'error'; error: Error };

// ─── BaseAgent ───

export abstract class BaseAgent {
  readonly name: string;
  readonly description?: string;
  readonly subAgents?: BaseAgent[];

  constructor(options: { name: string; description?: string; subAgents?: BaseAgent[] }) {
    this.name = options.name;
    this.description = options.description;
    this.subAgents = options.subAgents;
  }

  abstract run(context: InvocationContext): AsyncGenerator<AgentEvent>;
}
