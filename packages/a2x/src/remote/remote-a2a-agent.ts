/**
 * RemoteA2AAgent - Phase 3 stub.
 */

import type { AgentEvent } from '../agent/base-agent.js';
import { BaseAgent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';

export interface RemoteA2AAgentOptions {
  name: string;
  description: string;
  agentCardUrl: string;
  auth?: { token: string; scheme?: string };
}

export class RemoteA2AAgent extends BaseAgent {
  readonly agentCardUrl: string;
  readonly auth?: { token: string; scheme?: string };

  constructor(options: RemoteA2AAgentOptions) {
    super({ name: options.name, description: options.description });
    this.agentCardUrl = options.agentCardUrl;
    this.auth = options.auth;
  }

  async *run(_context: InvocationContext): AsyncGenerator<AgentEvent> {
    throw new Error('RemoteA2AAgent not yet implemented (Phase 3)');
  }
}
