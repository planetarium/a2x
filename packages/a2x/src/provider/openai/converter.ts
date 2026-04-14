/**
 * OpenAI message/tool format converters.
 * Converts between a2x types and OpenAI SDK types.
 */

import type OpenAI from 'openai';
import type { Message, Part } from '../../types/common.js';
import type { ToolDeclaration, ToolCall, LlmResponse } from '../../agent/llm-provider.js';
import { isTextPart } from '../../types/common.js';

// ─── Tool Result metadata shape ───

interface ToolResultMeta {
  id: string;
  name: string;
  result: unknown;
}

// ─── a2x Message[] → OpenAI ChatCompletionMessageParam[] ───

export function toOpenAIMessages(
  messages: Message[],
): OpenAI.ChatCompletionMessageParam[] {
  const result: OpenAI.ChatCompletionMessageParam[] = [];

  for (const msg of messages) {
    // Tool result messages
    if (msg.metadata?.toolResults) {
      const toolResults = msg.metadata.toolResults as ToolResultMeta[];
      for (const r of toolResults) {
        result.push({
          role: 'tool',
          tool_call_id: r.id,
          content:
            typeof r.result === 'string'
              ? r.result
              : JSON.stringify(r.result),
        });
      }
      continue;
    }

    if (msg.role === 'agent') {
      // Assistant message
      const textContent = msg.parts
        .filter(isTextPart)
        .map((p) => p.text)
        .join('');

      const assistantMsg: OpenAI.ChatCompletionAssistantMessageParam = {
        role: 'assistant',
        content: textContent || null,
      };

      // If metadata contains toolCalls, add them
      if (msg.metadata?.toolCalls) {
        const toolCalls = msg.metadata.toolCalls as ToolCall[];
        assistantMsg.tool_calls = toolCalls.map((tc) => ({
          id: tc.id,
          type: 'function' as const,
          function: {
            name: tc.name,
            arguments: JSON.stringify(tc.args),
          },
        }));
      }

      result.push(assistantMsg);
    } else {
      // User message
      const textContent = msg.parts
        .filter(isTextPart)
        .map((p) => p.text)
        .join('');

      result.push({
        role: 'user',
        content: textContent,
      });
    }
  }

  return result;
}

// ─── a2x ToolDeclaration[] → OpenAI ChatCompletionTool[] ───

export function toOpenAITools(
  tools: ToolDeclaration[],
): OpenAI.ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }));
}

// ─── OpenAI Response → a2x LlmResponse ───

export function fromOpenAIResponse(
  response: OpenAI.ChatCompletion,
): LlmResponse {
  const choice = response.choices[0];
  if (!choice) {
    return { content: [], finishReason: 'stop' };
  }

  const content: Part[] = [];
  const toolCalls: ToolCall[] = [];

  if (choice.message.content) {
    content.push({ text: choice.message.content });
  }

  if (choice.message.tool_calls) {
    for (const tc of choice.message.tool_calls) {
      if (tc.type === 'function') {
        toolCalls.push({
          id: tc.id,
          name: tc.function.name,
          args: JSON.parse(tc.function.arguments),
        });
      }
    }
  }

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason: choice.finish_reason ?? 'stop',
  };
}
