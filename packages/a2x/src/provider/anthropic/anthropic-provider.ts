/**
 * AnthropicProvider - LLM provider for Anthropic Claude models.
 * Requires: npm install @anthropic-ai/sdk
 */

import { BaseLlmProvider } from '../base.js';
import type { BaseLlmProviderOptions } from '../base.js';
import type { LlmRequest, LlmResponse } from '../../agent/llm-provider.js';
import { toAnthropicMessages, toAnthropicTools, fromAnthropicResponse } from './converter.js';

// ─── Options ───

export interface AnthropicProviderOptions extends BaseLlmProviderOptions {
  apiKey: string;
  baseUrl?: string;
}

// ─── AnthropicProvider ───

export class AnthropicProvider extends BaseLlmProvider {
  readonly name = 'anthropic';
  private client: unknown;
  private readonly apiKey?: string;
  private readonly baseUrl?: string;

  constructor(options: AnthropicProviderOptions) {
    super(options);
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
  }

  private async getClient(): Promise<InstanceType<typeof import('@anthropic-ai/sdk').default>> {
    if (!this.client) {
      let Anthropic: typeof import('@anthropic-ai/sdk').default;
      try {
        Anthropic = (await import('@anthropic-ai/sdk')).default;
      } catch {
        throw new Error(
          'AnthropicProvider requires "@anthropic-ai/sdk" package. Install it with: npm install @anthropic-ai/sdk',
        );
      }
      this.client = new Anthropic({
        apiKey: this.apiKey,
        baseURL: this.baseUrl,
      });
    }
    return this.client as InstanceType<typeof import('@anthropic-ai/sdk').default>;
  }

  async generateContent(request: LlmRequest): Promise<LlmResponse> {
    const client = await this.getClient();

    const response = await client.messages.create({
      model: this.model,
      max_tokens: this.maxTokens,
      system: request.systemInstruction,
      messages: toAnthropicMessages(request.contents),
      tools: request.tools ? toAnthropicTools(request.tools) : undefined,
    });

    return fromAnthropicResponse(response);
  }
}
