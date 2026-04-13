/**
 * Layer 2: SequentialAgent - runs sub-agents sequentially.
 * Full implementation deferred to Phase 2.
 */

import type { InvocationContext } from '../runner/context.js';
import { BaseAgent } from './base-agent.js';
import type { AgentEvent } from './base-agent.js';

export interface SequentialAgentOptions {
  name: string;
  description?: string;
  subAgents: BaseAgent[];
}

export class SequentialAgent extends BaseAgent {
  constructor(options: SequentialAgentOptions) {
    super({
      name: options.name,
      description: options.description,
      subAgents: options.subAgents,
    });
  }

  async *run(_context: InvocationContext): AsyncGenerator<AgentEvent> {
    // Phase 2: iterate subAgents sequentially
    yield { type: 'done' };
  }
}
