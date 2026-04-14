/**
 * Google Gemini message/tool format converters.
 * Converts between a2x types and @google/genai SDK types.
 */

import type { Content, FunctionDeclaration, GenerateContentResponse, Part as GooglePart } from '@google/genai';
import type { Message, Part } from '../../types/common.js';
import type { ToolDeclaration, ToolCall, LlmResponse } from '../../agent/llm-provider.js';
import { isTextPart } from '../../types/common.js';

// ─── Tool Result metadata shape ───

interface ToolResultMeta {
  id: string;
  name: string;
  result: unknown;
}

// ─── a2x Message[] → Google Content[] ───

export function toGoogleContents(messages: Message[]): Content[] {
  const result: Content[] = [];

  for (const msg of messages) {
    // Tool result messages
    if (msg.metadata?.toolResults) {
      const toolResults = msg.metadata.toolResults as ToolResultMeta[];
      const parts: GooglePart[] = toolResults.map((r) => ({
        functionResponse: {
          name: r.name,
          response:
            typeof r.result === 'object' && r.result !== null
              ? (r.result as Record<string, unknown>)
              : { result: r.result },
        },
      }));
      result.push({ role: 'user', parts });
      continue;
    }

    const role: 'user' | 'model' = msg.role === 'agent' ? 'model' : 'user';
    const parts: GooglePart[] = [];

    for (const part of msg.parts) {
      if (isTextPart(part) && part.text) {
        parts.push({ text: part.text });
      }
    }

    // If metadata contains toolCalls, add functionCall parts (model message)
    if (msg.metadata?.toolCalls) {
      const toolCalls = msg.metadata.toolCalls as ToolCall[];
      for (const tc of toolCalls) {
        parts.push({
          functionCall: {
            name: tc.name,
            args: tc.args,
          },
        });
      }
    }

    if (parts.length > 0) {
      result.push({ role, parts });
    }
  }

  return result;
}

// ─── a2x ToolDeclaration[] → Google FunctionDeclaration[] ───

export function toGoogleTools(
  tools: ToolDeclaration[],
): FunctionDeclaration[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
  }));
}

// ─── Google Response → a2x LlmResponse ───

export function fromGoogleResponse(
  response: GenerateContentResponse,
): LlmResponse {
  const content: Part[] = [];
  const toolCalls: ToolCall[] = [];

  const candidates = response.candidates;
  if (!candidates || candidates.length === 0) {
    return { content: [], finishReason: 'stop' };
  }

  const candidate = candidates[0];
  const parts = candidate.content?.parts ?? [];

  for (const part of parts) {
    if (part.text) {
      content.push({ text: part.text });
    }
    if (part.functionCall) {
      toolCalls.push({
        id: `call_${part.functionCall.name}_${Date.now()}`,
        name: part.functionCall.name!,
        args: (part.functionCall.args ?? {}) as Record<string, unknown>,
      });
    }
  }

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: candidate.finishReason ?? 'stop',
  };
}
