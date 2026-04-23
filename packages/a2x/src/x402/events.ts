/**
 * Typed constructor for the `paymentRequired` AgentEvent variant.
 *
 * The event lives on the generic `AgentEvent` union (see
 * `agent/base-agent.ts`) with a loosely-typed `accepts: unknown` so the
 * base agent types stay independent of the x402 extension. This helper
 * narrows the builder side back to `X402Accept[]`, so agent code reads
 * naturally:
 *
 * ```ts
 * async *run(ctx) {
 *   yield paymentRequiredEvent({
 *     accepts: [{ network: 'base', amount: '120000000', ... }],
 *     embeddedObject: { 'ap2.mandates.CartMandate': cart },
 *   });
 *   yield { type: 'text', text: 'Paid! Shipping your shoes…' };
 *   yield { type: 'done' };
 * }
 * ```
 */

import type { AgentEvent } from '../agent/base-agent.js';
import type { X402Accept } from './types.js';

export interface PaymentRequiredEventOptions {
  /**
   * Inline payment options. If omitted, the executor's `resolveAccepts`
   * hook is consulted; if neither produces a non-empty list, the event
   * fails the task with `NO_REQUIREMENTS`.
   */
  accepts?: X402Accept[];
  /**
   * Higher-level embedded object (e.g. an AP2 `CartMandate`) to carry
   * alongside the x402 challenge on the emitted artifact. The SDK adds
   * `x402.payment.required` alongside whatever shape you pass here.
   */
  embeddedObject?: unknown;
  /** Override the generated artifact id. */
  artifactId?: string;
  /** Override the default artifact name (`x402-payment-required`). */
  artifactName?: string;
  /** Optional artifact-level metadata. */
  artifactMetadata?: Record<string, unknown>;
}

export function paymentRequiredEvent(
  options: PaymentRequiredEventOptions = {},
): AgentEvent {
  const event: Extract<AgentEvent, { type: 'paymentRequired' }> = {
    type: 'paymentRequired',
  };
  if (options.accepts !== undefined) event.accepts = options.accepts;
  if (options.embeddedObject !== undefined) event.embeddedObject = options.embeddedObject;
  if (options.artifactId !== undefined) event.artifactId = options.artifactId;
  if (options.artifactName !== undefined) event.artifactName = options.artifactName;
  if (options.artifactMetadata !== undefined) event.artifactMetadata = options.artifactMetadata;
  return event;
}
