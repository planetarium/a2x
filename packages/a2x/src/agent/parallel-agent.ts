/**
 * Layer 2: ParallelAgent - runs sub-agents in parallel.
 * Full implementation deferred to Phase 2.
 */

import type { InvocationContext } from '../runner/context.js';
import { BaseAgent } from './base-agent.js';
import type { AgentEvent } from './base-agent.js';

export interface ParallelAgentOptions {
  name: string;
  description?: string;
  subAgents: BaseAgent[];
}

export class ParallelAgent extends BaseAgent {
  constructor(options: ParallelAgentOptions) {
    super({
      name: options.name,
      description: options.description,
      subAgents: options.subAgents,
    });
  }

  async *run(_context: InvocationContext): AsyncGenerator<AgentEvent> {
    // Phase 2: run subAgents in parallel
    yield { type: 'done' };
  }
}
