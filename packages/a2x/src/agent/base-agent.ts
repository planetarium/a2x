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
     * `task.status = INPUT_REQUIRED`, and merges `metadata` into the wire
     * status message metadata. The SDK does not record any cross-turn
     * bookkeeping — the agent re-derives its state on the resume turn from
     * the incoming message (`InvocationContext.message`) and from any
     * durable state the agent itself persists.
     */
    type: 'request-input';
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
  }
  | {
    /**
     * Successful terminal event. The default `AgentExecutor` transitions
     * the task to `completed` and merges the optional `metadata` onto the
     * final status message (`task.status.message.metadata`). Agents use
     * this to attach extension result metadata (e.g. x402 settlement
     * receipts) to the response.
     */
    type: 'done';
    output?: unknown;
    metadata?: Record<string, unknown>;
  }
  | {
    /**
     * Failure terminal event. The default `AgentExecutor` transitions the
     * task to `failed` with `error.message` as the status text and merges
     * the optional `metadata` onto the final status message metadata.
     * Agents use the metadata channel to attach failure detail keys (e.g.
     * `x402.payment.status: 'payment-failed'`, `x402.payment.error: <code>`).
     */
    type: 'error';
    error: Error;
    metadata?: Record<string, unknown>;
  };

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
