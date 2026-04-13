/**
 * Layer 2: AgentTool - wraps an agent as a tool.
 * Full implementation deferred to Phase 2.
 */

import type { BaseAgent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';
import { BaseTool } from './base-tool.js';

export interface AgentToolOptions {
  agent: BaseAgent;
}

export class AgentTool extends BaseTool {
  readonly name: string;
  readonly description: string;
  readonly agent: BaseAgent;

  constructor(options: AgentToolOptions) {
    super();
    this.agent = options.agent;
    this.name = `agent_${options.agent.name}`;
    this.description =
      options.agent.description ?? `Delegates to agent: ${options.agent.name}`;
  }

  getParameterSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        input: { type: 'string', description: 'Input message for the agent' },
      },
      required: ['input'],
    };
  }

  async execute(
    _args: Record<string, unknown>,
    _context: InvocationContext,
  ): Promise<unknown> {
    // Phase 2: delegate to agent.run()
    throw new Error('AgentTool.execute() not yet implemented (Phase 2)');
  }
}
