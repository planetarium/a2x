/**
 * Layer 2: FunctionTool - wraps a function with schema as a tool.
 * Full implementation deferred to Phase 2, basic structure for Phase 1.
 */

import type { InvocationContext } from '../runner/context.js';
import { BaseTool } from './base-tool.js';

export interface FunctionToolOptions<T = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema or zod schema (Phase 2)
  execute: (args: T, context: InvocationContext) => Promise<unknown>;
}

export class FunctionTool<T = unknown> extends BaseTool {
  readonly name: string;
  readonly description: string;
  private readonly _parameters: Record<string, unknown>;
  private readonly _execute: (args: T, context: InvocationContext) => Promise<unknown>;

  constructor(options: FunctionToolOptions<T>) {
    super();
    this.name = options.name;
    this.description = options.description;
    this._parameters = options.parameters;
    this._execute = options.execute;
  }

  getParameterSchema(): Record<string, unknown> {
    return this._parameters;
  }

  async execute(args: Record<string, unknown>, context: InvocationContext): Promise<unknown> {
    return this._execute(args as unknown as T, context);
  }
}
