/**
 * Layer 2: LLM Provider abstraction interface.
 * SDK does not include LLM provider implementations.
 * Users inject their own provider or use a model string with a registered factory.
 */

import type { Message, Part } from '../types/common.js';

// ─── Tool Declaration (for LLM function calling) ───

export interface ToolDeclaration {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
}

// ─── Tool Call ───

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

// ─── LLM Request ───

export interface LlmRequest {
  model: string;
  contents: Message[];
  systemInstruction?: string;
  tools?: ToolDeclaration[];
}

// ─── LLM Response ───

export interface LlmResponse {
  content: Part[];
  toolCalls?: ToolCall[];
  finishReason: string;
}

// ─── LLM Stream Chunk ───

export interface LlmStreamChunk {
  content?: Part[];
  toolCalls?: ToolCall[];
  finishReason?: string;
}

// ─── LLM Provider Interface ───

export interface LlmProvider {
  generateContent(request: LlmRequest): Promise<LlmResponse>;
  generateContentStream?(request: LlmRequest): AsyncGenerator<LlmStreamChunk>;
}

// ─── Model Request / Response (for callbacks) ───

export interface ModelRequest {
  model: string;
  contents: Message[];
  systemInstruction?: string;
  tools?: ToolDeclaration[];
}

export interface ModelResponse {
  content: Part[];
  toolCalls?: ToolCall[];
  finishReason: string;
}
