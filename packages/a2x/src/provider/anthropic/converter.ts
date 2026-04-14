/**
 * Anthropic message/tool format converters.
 * Converts between a2x types and Anthropic SDK types.
 */

import type Anthropic from '@anthropic-ai/sdk';
import type { Message, Part } from '../../types/common.js';
import type { ToolDeclaration, ToolCall, LlmResponse } from '../../agent/llm-provider.js';
import { isTextPart } from '../../types/common.js';

// ─── Tool Result metadata shape ───

interface ToolResultMeta {
  id: string;
  name: string;
  result: unknown;
}

// ─── a2x Message[] → Anthropic MessageParam[] ───

export function toAnthropicMessages(
  messages: Message[],
): Anthropic.MessageParam[] {
  const result: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    // Tool result messages (metadata.toolResults present)
    if (msg.metadata?.toolResults) {
      const toolResults = msg.metadata.toolResults as ToolResultMeta[];
      result.push({
        role: 'user',
        content: toolResults.map((r) => ({
          type: 'tool_result' as const,
          tool_use_id: r.id,
          content:
            typeof r.result === 'string'
              ? r.result
              : JSON.stringify(r.result),
        })),
      });
      continue;
    }

    const role: 'user' | 'assistant' =
      msg.role === 'agent' ? 'assistant' : 'user';
    const content = convertPartsToAnthropicContent(msg.parts, msg.metadata);

    if (content.length > 0) {
      result.push({ role, content });
    }
  }

  return result;
}

// ─── Parts → Anthropic ContentBlockParam[] ───

function convertPartsToAnthropicContent(
  parts: Part[],
  metadata?: Record<string, unknown>,
): Anthropic.ContentBlockParam[] {
  const blocks: Anthropic.ContentBlockParam[] = [];

  // If metadata contains toolCalls, add tool_use blocks (assistant message)
  if (metadata?.toolCalls) {
    const toolCalls = metadata.toolCalls as ToolCall[];
    for (const tc of toolCalls) {
      blocks.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.name,
        input: tc.args,
      });
    }
  }

  for (const part of parts) {
    if (isTextPart(part) && part.text) {
      blocks.push({ type: 'text', text: part.text });
    }
  }

  return blocks;
}

// ─── a2x ToolDeclaration[] → Anthropic Tool[] ───

export function toAnthropicTools(
  tools: ToolDeclaration[],
): Anthropic.Tool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters as Anthropic.Tool.InputSchema,
  }));
}

// ─── Anthropic Response → a2x LlmResponse ───

export function fromAnthropicResponse(
  response: Anthropic.Message,
): LlmResponse {
  const content: Part[] = [];
  const toolCalls: ToolCall[] = [];

  for (const block of response.content) {
    if (block.type === 'text') {
      content.push({ text: block.text });
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: block.id,
        name: block.name,
        args: block.input as Record<string, unknown>,
      });
    }
  }

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: response.stop_reason ?? 'stop',
  };
}
