/**
 * Layer 2: BaseLlmProvider - abstract base class for LLM providers.
 * Extend this class to implement a custom LLM provider with minimal boilerplate.
 */

import type {
  LlmProvider,
  LlmRequest,
  LlmResponse,
  LlmStreamChunk,
} from '../agent/llm-provider.js';

// ─── BaseLlmProvider Options ───

export interface BaseLlmProviderOptions {
  model: string;
  maxTokens?: number;
}

// ─── BaseLlmProvider ───

export abstract class BaseLlmProvider implements LlmProvider {
  /** Provider identifier (e.g., 'anthropic', 'openai', 'google') */
  abstract readonly name: string;

  /** Model identifier (e.g., 'claude-sonnet-4-20250514', 'gpt-4o') */
  readonly model: string;

  /** Maximum tokens to generate */
  protected readonly maxTokens: number;

  constructor(options: BaseLlmProviderOptions) {
    this.model = options.model;
    this.maxTokens = options.maxTokens ?? 8192;
  }

  abstract generateContent(request: LlmRequest): Promise<LlmResponse>;

  async *generateContentStream(
    _request: LlmRequest,
  ): AsyncGenerator<LlmStreamChunk> {
    throw new Error(
      `${this.name} provider does not support streaming. Override generateContentStream() to enable.`,
    );
  }
}
