/**
 * OpenAIProvider - LLM provider for OpenAI models.
 * Requires: npm install openai
 */

import { BaseLlmProvider } from '../base.js';
import type { BaseLlmProviderOptions } from '../base.js';
import type { LlmRequest, LlmResponse } from '../../agent/llm-provider.js';
import { toOpenAIMessages, toOpenAITools, fromOpenAIResponse } from './converter.js';

// ─── Options ───

export interface OpenAIProviderOptions extends BaseLlmProviderOptions {
  apiKey: string;
  baseUrl?: string;
}

// ─── OpenAIProvider ───

export class OpenAIProvider extends BaseLlmProvider {
  readonly name = 'openai';
  private client: unknown;
  private readonly apiKey?: string;
  private readonly baseUrl?: string;

  constructor(options: OpenAIProviderOptions) {
    super(options);
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
  }

  private async getClient(): Promise<InstanceType<typeof import('openai').default>> {
    if (!this.client) {
      let OpenAI: typeof import('openai').default;
      try {
        OpenAI = (await import('openai')).default;
      } catch {
        throw new Error(
          'OpenAIProvider requires "openai" package. Install it with: npm install openai',
        );
      }
      this.client = new OpenAI({
        apiKey: this.apiKey,
        baseURL: this.baseUrl,
      });
    }
    return this.client as InstanceType<typeof import('openai').default>;
  }

  async generateContent(request: LlmRequest): Promise<LlmResponse> {
    const client = await this.getClient();

    const messages = toOpenAIMessages(request.contents);

    // Prepend system message if systemInstruction is provided
    if (request.systemInstruction) {
      messages.unshift({
        role: 'system',
        content: request.systemInstruction,
      });
    }

    const response = await client.chat.completions.create({
      model: this.model,
      max_tokens: this.maxTokens,
      messages,
      tools: request.tools ? toOpenAITools(request.tools) : undefined,
    });

    return fromOpenAIResponse(response);
  }
}
