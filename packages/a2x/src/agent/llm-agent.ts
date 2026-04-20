/**
 * Layer 2: LlmAgent - an agent that uses an LLM provider.
 */

import type { BaseTool } from '../tool/base-tool.js';
import type { InvocationContext } from '../runner/context.js';
import type {
  LlmProvider,
  LlmRequest,
  ModelRequest,
  ModelResponse,
  ToolDeclaration,
} from './llm-provider.js';
import type { Part, Message } from '../types/common.js';
import { isTextPart } from '../types/common.js';
import { BaseAgent } from './base-agent.js';
import type { AgentEvent } from './base-agent.js';
import { eventsToContents } from '../runner/event-history.js';
import {
  runBeforeModelCallbacks,
  runAfterModelCallbacks,
  runBeforeToolCallbacks,
  runAfterToolCallbacks,
} from '../runner/callback-runner.js';

const DEFAULT_MAX_LLM_CALLS = 25;

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
  maxLlmCalls?: number;
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
  readonly maxLlmCalls?: number;
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
    this.maxLlmCalls = options.maxLlmCalls;
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

  /**
   * Build ToolDeclaration[] from registered tools.
   */
  private buildToolDeclarations(): ToolDeclaration[] {
    return this.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.getParameterSchema(),
    }));
  }

  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    const plugins = context.plugins ?? [];
    const maxCalls = context.maxLlmCalls ?? this.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS;
    let llmCallCount = 0;

    // 1. Resolve instruction
    let systemInstruction: string;
    try {
      systemInstruction = await this.getInstruction(context);
    } catch (err) {
      yield { type: 'error', error: new Error(`[LlmAgent:${this.name}] Failed to resolve instruction: ${(err as Error).message}`) };
      return;
    }

    // 2. Build tool declarations
    const toolDeclarations = this.buildToolDeclarations();

    // 3. Build initial contents from session history
    const contents: Message[] = eventsToContents(context.session.events);

    // 4. LLM call loop
    while (llmCallCount < maxCalls) {
      // Check for abort before each LLM call
      if (context.signal?.aborted) return;

      // Build LlmRequest
      const llmRequest: LlmRequest = {
        contents,
        systemInstruction,
        tools: toolDeclarations.length > 0 ? toolDeclarations : undefined,
      };

      // Build ModelRequest for callbacks (includes model name)
      const modelRequest: ModelRequest = {
        model: this.modelName,
        ...llmRequest,
      };

      // Run beforeModel callbacks
      let response: ModelResponse;
      try {
        const intercepted = await runBeforeModelCallbacks(
          modelRequest, context, plugins, this.beforeModelCallback,
        );

        if (intercepted) {
          // Callback returned a response — skip LLM call
          response = intercepted;
        } else {
          // Call the LLM provider
          const llmResponse = await this.provider.generateContent(llmRequest);
          llmCallCount++;
          response = {
            content: llmResponse.content,
            toolCalls: llmResponse.toolCalls,
            finishReason: llmResponse.finishReason,
          };
        }

        // Run afterModel callbacks
        response = await runAfterModelCallbacks(
          response, context, plugins, this.afterModelCallback,
        );
      } catch (err) {
        yield { type: 'error', error: new Error(`[LlmAgent:${this.name}] LLM call failed: ${(err as Error).message}`) };
        return;
      }

      // 5. Yield text content
      const textParts = response.content.filter(isTextPart);
      for (const part of textParts) {
        if (part.text) {
          yield { type: 'text', text: part.text, role: 'agent' };
        }
      }

      // 6. If no tool calls, we're done
      if (!response.toolCalls || response.toolCalls.length === 0) {
        // Handle outputKey
        const finalText = textParts.map((p) => p.text).join('');
        if (this.outputKey && finalText) {
          context.state[this.outputKey] = finalText;
          yield { type: 'done', output: finalText };
        } else {
          yield { type: 'done' };
        }
        return;
      }

      // 7. Append assistant message with toolCalls to contents
      const assistantParts: Part[] = textParts.map((p) => ({ text: p.text }));
      contents.push({
        messageId: `agent-${Date.now()}`,
        role: 'agent',
        parts: assistantParts.length > 0 ? assistantParts : [{ text: '' }],
        metadata: { toolCalls: response.toolCalls },
      });

      // 8. Execute tool calls sequentially
      const toolResults: { id: string; name: string; result: unknown }[] = [];

      for (const toolCall of response.toolCalls) {
        // Check for abort before each tool execution
        if (context.signal?.aborted) return;

        yield { type: 'toolCall', toolName: toolCall.name, args: toolCall.args, toolCallId: toolCall.id };

        const tool = this.tools.find((t) => t.name === toolCall.name);

        let result: unknown;
        try {
          if (!tool) {
            result = `Error: Tool "${toolCall.name}" not found in agent "${this.name}"`;
          } else {
            // Run beforeTool callbacks
            const interceptedResult = await runBeforeToolCallbacks(
              tool, toolCall.args, context, plugins, this.beforeToolCallback,
            );

            if (interceptedResult !== undefined) {
              result = interceptedResult;
            } else {
              result = await tool.execute(toolCall.args, context);
            }

            // Run afterTool callbacks
            result = await runAfterToolCallbacks(
              tool, toolCall.args, result, context, plugins,
            );
          }
        } catch (err) {
          result = `Error: Tool "${toolCall.name}" execution failed: ${(err as Error).message}`;
        }

        yield { type: 'toolResult', toolName: toolCall.name, result, toolCallId: toolCall.id };
        toolResults.push({ id: toolCall.id, name: toolCall.name, result });
      }

      // 9. Append tool results to contents
      contents.push({
        messageId: `tool-results-${Date.now()}`,
        role: 'user',
        parts: [{ text: '' }],
        metadata: { toolResults },
      });

      // Loop continues — next iteration will call LLM again with updated contents
    }

    // Max LLM calls reached — yield done with whatever we have
    yield { type: 'done' };
  }
}
