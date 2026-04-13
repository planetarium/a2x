/**
 * Layer 2: EXIT_LOOP built-in tool for LoopAgent.
 * Full implementation deferred to Phase 2.
 */

import type { InvocationContext } from '../runner/context.js';
import { BaseTool } from './base-tool.js';

class ExitLoopTool extends BaseTool {
  readonly name = 'EXIT_LOOP';
  readonly description = 'Call this tool to exit the current loop iteration.';

  getParameterSchema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {},
    };
  }

  async execute(
    _args: Record<string, unknown>,
    _context: InvocationContext,
  ): Promise<unknown> {
    // Phase 2: signal loop exit
    return { exitLoop: true };
  }
}

export const EXIT_LOOP: BaseTool = new ExitLoopTool();
