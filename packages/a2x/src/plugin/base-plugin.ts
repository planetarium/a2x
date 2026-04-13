/**
 * Layer 2: BasePlugin abstract class.
 * Full callback implementation deferred to Phase 2.
 */

import type { BaseTool } from '../tool/base-tool.js';
import type { InvocationContext } from '../runner/context.js';
import type { ModelRequest, ModelResponse } from '../agent/llm-provider.js';

export abstract class BasePlugin {
  abstract readonly name: string;

  beforeModelCallback?(
    request: ModelRequest,
    context: InvocationContext,
  ): Promise<ModelResponse | undefined>;

  afterModelCallback?(
    response: ModelResponse,
    context: InvocationContext,
  ): Promise<ModelResponse | undefined>;

  beforeToolCallback?(
    tool: BaseTool,
    args: Record<string, unknown>,
    context: InvocationContext,
  ): Promise<unknown | undefined>;

  afterToolCallback?(
    tool: BaseTool,
    args: Record<string, unknown>,
    result: unknown,
    context: InvocationContext,
  ): Promise<unknown | undefined>;
}
