/**
 * Layer 2: LoopAgent - runs sub-agents in a loop.
 * Full implementation deferred to Phase 2.
 */

import type { InvocationContext } from '../runner/context.js';
import { BaseAgent } from './base-agent.js';
import type { AgentEvent } from './base-agent.js';

export interface LoopAgentOptions {
  name: string;
  description?: string;
  subAgents: BaseAgent[];
  maxIterations: number;
}

export class LoopAgent extends BaseAgent {
  readonly maxIterations: number;

  constructor(options: LoopAgentOptions) {
    super({
      name: options.name,
      description: options.description,
      subAgents: options.subAgents,
    });
    this.maxIterations = options.maxIterations;
  }

  async *run(_context: InvocationContext): AsyncGenerator<AgentEvent> {
    // Phase 2: loop with EXIT_LOOP support
    yield { type: 'done' };
  }
}
