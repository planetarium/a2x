/**
 * Layer 2: BaseAgent abstract class.
 */

import type { InvocationContext } from '../runner/context.js';

// ─── AgentEvent (events yielded by agents to the Runner) ───

export type AgentEvent =
  | { type: 'text'; text: string; role?: 'user' | 'agent' }
  | { type: 'toolCall'; toolName: string; args: Record<string, unknown>; toolCallId?: string }
  | { type: 'toolResult'; toolName: string; result: unknown; toolCallId?: string }
  | { type: 'done'; output?: unknown }
  | { type: 'error'; error: Error }
  | {
      /**
       * Request an additional payment mid-execution. The wrapping executor
       * (e.g. `X402PaymentExecutor`) converts this event into an embedded
       * payment challenge on an artifact and suspends the task into
       * `input-required`. Execution resumes on the next client message
       * carrying the signed payload. Executors that don't know about
       * payments ignore this event.
       */
      type: 'paymentRequired';
      /**
       * Inline payment options. Loosely typed so this variant stays
       * independent of the x402 extension package; the x402 executor
       * casts to `X402Accept[]` when present.
       */
      accepts?: unknown;
      /**
       * Opaque higher-level object to embed alongside the x402 challenge
       * (e.g. an AP2 `CartMandate`). Passed to `resolveAccepts()` when
       * `accepts` is omitted, and rendered as the artifact's data part.
       */
      embeddedObject?: unknown;
      /** Optional artifact id. Executor generates one when omitted. */
      artifactId?: string;
      /** Optional artifact name. Default: `x402-payment-required`. */
      artifactName?: string;
      /** Optional artifact-level metadata. */
      artifactMetadata?: Record<string, unknown>;
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
