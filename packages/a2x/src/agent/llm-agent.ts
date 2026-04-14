/**
 * Layer 2: LlmAgent - an agent that uses an LLM provider.
 */

import type { BaseTool } from '../tool/base-tool.js';
import type { InvocationContext } from '../runner/context.js';
import type { ModelRequest, ModelResponse, LlmProvider } from './llm-provider.js';
import { BaseAgent } from './base-agent.js';
import type { AgentEvent } from './base-agent.js';

// ─── Callback Types ───

export type BeforeModelCallback = (
  request: ModelRequest,
  context: InvocationContext,
) => Promise<ModelResponse | undefined>;

export type AfterModelCallback = (
  response: ModelResponse,
  context: InvocationContext,
) => Promise<ModelResponse | undefined>;

export type BeforeToolCallback = (
  tool: BaseTool,
  args: Record<string, unknown>,
  context: InvocationContext,
) => Promise<unknown | undefined>;

// ─── LlmAgent Options ───

export interface LlmAgentOptions {
  name: string;
  provider: LlmProvider;
  description?: string;
  instruction: string | ((context: InvocationContext) => string | Promise<string>);
  tools?: BaseTool[];
  outputSchema?: Record<string, unknown>;
  outputKey?: string;
  beforeModelCallback?: BeforeModelCallback;
  afterModelCallback?: AfterModelCallback;
  beforeToolCallback?: BeforeToolCallback;
}

// ─── LlmAgent ───

export class LlmAgent extends BaseAgent {
  readonly provider: LlmProvider;
  readonly instruction: string | ((context: InvocationContext) => string | Promise<string>);
  readonly tools: BaseTool[];
  readonly outputSchema?: Record<string, unknown>;
  readonly outputKey?: string;
  readonly beforeModelCallback?: BeforeModelCallback;
  readonly afterModelCallback?: AfterModelCallback;
  readonly beforeToolCallback?: BeforeToolCallback;

  constructor(options: LlmAgentOptions) {
    super({ name: options.name, description: options.description });
    this.provider = options.provider;
    this.instruction = options.instruction;
    this.tools = options.tools ?? [];
    this.outputSchema = options.outputSchema;
    this.outputKey = options.outputKey;
    this.beforeModelCallback = options.beforeModelCallback;
    this.afterModelCallback = options.afterModelCallback;
    this.beforeToolCallback = options.beforeToolCallback;
  }

  /**
   * Get the instruction string, resolving it if it is a function.
   */
  async getInstruction(context: InvocationContext): Promise<string> {
    if (typeof this.instruction === 'function') {
      return this.instruction(context);
    }
    return this.instruction;
  }

  /**
   * Get the model name from the provider.
   */
  get modelName(): string {
    if ('model' in this.provider && typeof this.provider.model === 'string') {
      return this.provider.model;
    }
    return 'custom';
  }

  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    // Phase 1: Basic stub implementation.
    // Real LLM interaction is handled by the Runner/AgentExecutor pipeline.
    // The LlmAgent.run() in Phase 1 yields a simple done event.
    // Full LLM call logic will be implemented when LlmProvider adapters are available.

    const instruction = await this.getInstruction(context);

    yield {
      type: 'text',
      text: `[LlmAgent:${this.name}] instruction: ${instruction.substring(0, 100)}...`,
    };

    yield { type: 'done' };
  }
}
