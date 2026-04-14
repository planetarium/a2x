/**
 * GoogleProvider - LLM provider for Google Gemini models.
 * Requires: npm install @google/genai
 */

import { BaseLlmProvider } from '../base.js';
import type { BaseLlmProviderOptions } from '../base.js';
import type { LlmRequest, LlmResponse } from '../../agent/llm-provider.js';
import { toGoogleContents, toGoogleTools, fromGoogleResponse } from './converter.js';

// ─── Options ───

export interface GoogleProviderOptions extends BaseLlmProviderOptions {
  apiKey: string;
  baseUrl?: string;
}

// ─── GoogleProvider ───

export class GoogleProvider extends BaseLlmProvider {
  readonly name = 'google';
  private client: unknown;
  private readonly apiKey?: string;
  private readonly baseUrl?: string;

  constructor(options: GoogleProviderOptions) {
    super(options);
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl;
  }

  private async getClient(): Promise<InstanceType<typeof import('@google/genai').GoogleGenAI>> {
    if (!this.client) {
      let GoogleGenAI: typeof import('@google/genai').GoogleGenAI;
      try {
        const mod = await import('@google/genai');
        GoogleGenAI = mod.GoogleGenAI;
      } catch {
        throw new Error(
          'GoogleProvider requires "@google/genai" package. Install it with: npm install @google/genai',
        );
      }
      this.client = new GoogleGenAI({
        apiKey: this.apiKey,
      });
    }
    return this.client as InstanceType<typeof import('@google/genai').GoogleGenAI>;
  }

  async generateContent(request: LlmRequest): Promise<LlmResponse> {
    const client = await this.getClient();

    const response = await client.models.generateContent({
      model: this.model,
      contents: toGoogleContents(request.contents),
      config: {
        systemInstruction: request.systemInstruction,
        maxOutputTokens: this.maxTokens,
        tools: request.tools
          ? [{ functionDeclarations: toGoogleTools(request.tools) }]
          : undefined,
      },
    });

    return fromGoogleResponse(response);
  }
}
