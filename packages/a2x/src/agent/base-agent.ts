/**
 * Layer 2: BaseAgent abstract class.
 */

import type { InvocationContext } from '../runner/context.js';

// ─── AgentEvent (events yielded by agents to the Runner) ───

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'toolCall'; toolName: string; args: Record<string, unknown> }
  | { type: 'toolResult'; toolName: string; result: unknown }
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
