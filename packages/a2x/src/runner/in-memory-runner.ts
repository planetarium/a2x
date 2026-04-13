/**
 * Layer 2: InMemoryRunner - runner with in-memory session storage.
 */

import type { BaseAgent } from '../agent/base-agent.js';
import type { BasePlugin } from '../plugin/base-plugin.js';
import { InMemorySessionService } from './in-memory-session.js';
import { Runner } from './runner.js';

export interface InMemoryRunnerOptions {
  agent: BaseAgent;
  appName: string;
  plugins?: BasePlugin[];
}

export class InMemoryRunner extends Runner {
  constructor(options: InMemoryRunnerOptions) {
    super({
      agent: options.agent,
      appName: options.appName,
      sessionService: new InMemorySessionService(),
      plugins: options.plugins,
    });
  }
}
