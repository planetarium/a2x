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
import type { Part, Message, FilePart, DataPart } from '../types/common.js';
import { isTextPart, isFilePart, isDataPart } from '../types/common.js';
import { BaseAgent } from './base-agent.js';
import type { AgentEvent } from './base-agent.js';
import { eventsToContents } from '../runner/event-history.js';
import {
  runBeforeModelCallbacks,
  runAfterModelCallbacks,
  runBeforeToolCallbacks,
  runAfterToolCallbacks,
} from '../runner/callback-runner.js';
import type { SkillsConfig } from '../skills/types.js';
import { SkillConfigError } from '../skills/errors.js';
import { SkillLoader } from '../skills/loader.js';
import { SkillRegistry } from '../skills/registry.js';
import { combineSystemInstruction } from '../skills/prompt.js';
import {
  createLoadSkillTool,
  LOAD_SKILL_TOOL_NAME,
  READ_SKILL_FILE_TOOL_NAME,
  RUN_SKILL_SCRIPT_TOOL_NAME,
} from '../skills/load-skill-tool.js';
import { createReadSkillFileTool } from '../skills/read-skill-file-tool.js';
import { createRunSkillScriptTool } from '../skills/run-skill-script-tool.js';

const RESERVED_SKILL_TOOL_NAMES: ReadonlySet<string> = new Set([
  LOAD_SKILL_TOOL_NAME,
  READ_SKILL_FILE_TOOL_NAME,
  RUN_SKILL_SCRIPT_TOOL_NAME,
]);

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
  /**
   * Claude Agent Skills (open standard) configuration. When set, the agent
   * eagerly loads all skill metadata and registers the `load_skill` /
   * `read_skill_file` / `run_skill_script` builtin tools automatically.
   * When undefined the agent behaves exactly as before.
   */
  skills?: SkillsConfig;
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
  /** Pending skill registry load. `null` when no skills are configured. */
  private readonly _skillsPromise: Promise<SkillRegistry> | null;
  /** Resolved skill registry (populated on first run). */
  private _skillRegistry: SkillRegistry | null = null;

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

    // Validate that the developer hasn't collided with the reserved skill
    // tool names. This is synchronous and fatal (FR-031).
    if (options.skills !== undefined) {
      for (const tool of this.tools) {
        if (RESERVED_SKILL_TOOL_NAMES.has(tool.name)) {
          throw new SkillConfigError(
            `tool name "${tool.name}" is reserved by the skill runtime; rename the tool or remove the "skills" option`,
          );
        }
      }
      this._skillsPromise = SkillLoader.load(options.skills).then(
        (res) => res.registry,
      );
    } else {
      this._skillsPromise = null;
    }
  }

  /**
   * Wait for the skill registry to finish loading. Returns `null` when the
   * agent was constructed without a `skills` option. Primarily intended for
   * tests; normal callers rely on `run()` resolving the registry before the
   * first LLM invocation (FR-081).
   */
  async whenSkillsReady(): Promise<SkillRegistry | null> {
    if (this._skillsPromise === null) return null;
    if (this._skillRegistry) return this._skillRegistry;
    this._skillRegistry = await this._skillsPromise;
    return this._skillRegistry;
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
   * Build ToolDeclaration[] from the supplied tool list (which includes any
   * skill builtin tools when a skill registry is active).
   */
  private buildToolDeclarations(tools: readonly BaseTool[]): ToolDeclaration[] {
    return tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.getParameterSchema(),
    }));
  }

  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    const plugins = context.plugins ?? [];
    const maxCalls = context.maxLlmCalls ?? this.maxLlmCalls ?? DEFAULT_MAX_LLM_CALLS;
    let llmCallCount = 0;

    // 0. Resolve skill registry (eager metadata, lazy bodies)
    let skillRegistry: SkillRegistry | null = null;
    if (this._skillsPromise !== null) {
      try {
        skillRegistry = await this.whenSkillsReady();
      } catch (err) {
        yield {
          type: 'error',
          error: new Error(
            `[LlmAgent:${this.name}] Failed to load skills: ${(err as Error).message}`,
          ),
        };
        return;
      }
    }

    // 1. Resolve instruction
    let systemInstruction: string;
    try {
      systemInstruction = await this.getInstruction(context);
    } catch (err) {
      yield { type: 'error', error: new Error(`[LlmAgent:${this.name}] Failed to resolve instruction: ${(err as Error).message}`) };
      return;
    }

    // 1a. Prepend the skill metadata block to the resolved instruction
    // (FR-020, FR-021). Provider-agnostic — identical for all providers.
    if (skillRegistry !== null) {
      systemInstruction = combineSystemInstruction(systemInstruction, skillRegistry);
    }

    // 2. Build the effective tool list. Skill builtin tools precede the
    // developer-supplied tools so that ordering is deterministic regardless
    // of whether the caller passed a tools array.
    const effectiveTools: BaseTool[] =
      skillRegistry !== null && !skillRegistry.isEmpty
        ? [
          createLoadSkillTool(skillRegistry),
          createReadSkillFileTool(skillRegistry),
          createRunSkillScriptTool(skillRegistry),
          ...this.tools,
        ]
        : this.tools;
    const toolDeclarations = this.buildToolDeclarations(effectiveTools);

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

      // 5. Yield content parts. Text/file/data are emitted as discrete
      // AgentEvents so multi-modal LLMs (image gen, structured output, …)
      // can stay on the BaseAgent path. Non-text parts are still kept out of
      // the LLM conversation history below — that history remains text-only.
      const textParts = response.content.filter(isTextPart);
      for (const part of response.content) {
        if (isTextPart(part)) {
          if (part.text) {
            yield {
              type: 'text',
              text: part.text,
              role: 'agent',
              ...(part.mediaType ? { mediaType: part.mediaType } : {}),
            };
          }
        } else if (isFilePart(part)) {
          const filePart = part as FilePart;
          yield {
            type: 'file',
            file: {
              ...(filePart.raw !== undefined ? { raw: filePart.raw } : {}),
              ...(filePart.url !== undefined ? { url: filePart.url } : {}),
              ...(filePart.mediaType !== undefined
                ? { mediaType: filePart.mediaType }
                : {}),
              ...(filePart.filename !== undefined
                ? { filename: filePart.filename }
                : {}),
            },
          };
        } else if (isDataPart(part)) {
          const dataPart = part as DataPart;
          yield {
            type: 'data',
            data: dataPart.data,
            ...(dataPart.mediaType ? { mediaType: dataPart.mediaType } : {}),
          };
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

        const tool = effectiveTools.find((t) => t.name === toolCall.name);

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
