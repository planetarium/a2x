/**
 * Layer 2: Event History Converter.
 * Converts AgentEvent[] from session history into Message[] for LLM contents.
 */

import type { AgentEvent } from '../agent/base-agent.js';
import type { Message } from '../types/common.js';
import { randomUUID } from 'node:crypto';

/**
 * Convert session events into LLM-compatible Message[].
 *
 * Mapping rules:
 * - text event with role 'user'  → { role: 'user', parts: [{ text }] }
 * - text event with role 'agent' → { role: 'agent', parts: [{ text }] }
 * - toolCall events are attached to the preceding agent message via metadata.toolCalls
 * - toolResult events become a separate message with metadata.toolResults
 * - done/error events are excluded
 */
export function eventsToContents(events: AgentEvent[]): Message[] {
  const messages: Message[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];

    switch (event.type) {
      case 'text': {
        const role = event.role ?? 'agent';
        messages.push({
          messageId: randomUUID(),
          role: role === 'user' ? 'user' : 'agent',
          parts: [{ text: event.text }],
        });
        break;
      }

      case 'toolCall': {
        // Attach tool call info to the last agent message, or create one
        const lastMsg = messages[messages.length - 1];
        if (lastMsg && lastMsg.role === 'agent') {
          if (!lastMsg.metadata) lastMsg.metadata = {};
          if (!lastMsg.metadata.toolCalls) lastMsg.metadata.toolCalls = [];
          (lastMsg.metadata.toolCalls as unknown[]).push({
            id: event.toolCallId ?? '',
            name: event.toolName,
            args: event.args,
          });
        }
        break;
      }

      case 'toolResult': {
        // Create a tool result message (sent as user role for re-submission to LLM)
        messages.push({
          messageId: randomUUID(),
          role: 'user',
          parts: [{ text: typeof event.result === 'string' ? event.result : JSON.stringify(event.result) }],
          metadata: {
            toolResults: [
              {
                id: event.toolCallId ?? '',
                name: event.toolName,
                result: event.result,
              },
            ],
          },
        });
        break;
      }

      // done and error events are not included in contents
      default:
        break;
    }
  }

  return messages;
}
