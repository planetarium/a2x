/**
 * Layer 2: BaseTool abstract class.
 */

import type { InvocationContext } from '../runner/context.js';

export abstract class BaseTool {
  abstract readonly name: string;
  abstract readonly description: string;

  abstract getParameterSchema(): Record<string, unknown>;
  abstract execute(
    args: Record<string, unknown>,
    context: InvocationContext,
  ): Promise<unknown>;
}
