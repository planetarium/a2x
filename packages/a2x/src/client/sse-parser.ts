/**
 * Client-side SSE (Server-Sent Events) stream parser.
 * Counterpart to server-side src/transport/sse-handler.ts.
 *
 * Supports two SSE formats:
 *
 * Format A (a2x server — has event: field):
 *   event: status_update\ndata: {event object}\n\n
 *   event: artifact_update\ndata: {event object}\n\n
 *   event: done\ndata: {}\n\n
 *   event: error\ndata: {error message}\n\n
 *
 * Format B (ADK-based servers — data-only, JSON-RPC wrapped):
 *   data: {"jsonrpc":"2.0","id":1,"result":{event object with "kind" field}}\n\n
 */

import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types/task.js';
import { TERMINAL_STATES, TaskState } from '../types/task.js';
import type { ResponseParser } from './response-parser.js';

// ─── SSE Event Types (a2x server format) ───

const SSE_EVENT = {
  STATUS_UPDATE: 'status_update',
  ARTIFACT_UPDATE: 'artifact_update',
  DONE: 'done',
  ERROR: 'error',
  MESSAGE: 'message',
} as const;

// ─── SSE Parser ───

interface ParsedSSEEvent {
  event: string; // empty string when no event: field (SSE standard default: "message")
  data: string;
}

/**
 * Parse SSE blocks from a text buffer. Returns parsed events and any remaining buffer.
 */
function extractSSEEvents(buffer: string): {
  events: ParsedSSEEvent[];
  remaining: string;
} {
  const events: ParsedSSEEvent[] = [];
  const blocks = buffer.split('\n\n');

  // Last element is either empty (complete block) or a partial block (remaining)
  const remaining = blocks.pop() ?? '';

  for (const block of blocks) {
    if (!block.trim()) continue;

    let event = '';
    const dataLines: string[] = [];

    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) {
        event = line.slice(7);
      } else if (line.startsWith('event:')) {
        event = line.slice(6);
      } else if (line.startsWith('data: ')) {
        dataLines.push(line.slice(6));
      } else if (line.startsWith('data:')) {
        dataLines.push(line.slice(5));
      }
      // Lines starting with ':' are comments — ignored per SSE spec
    }

    if (dataLines.length > 0) {
      events.push({ event, data: dataLines.join('\n') });
    }
  }

  return { events, remaining };
}

/**
 * Unwrap data payload. Handles both raw event objects and JSON-RPC wrapped format.
 * Returns the actual event object.
 */
function unwrapData(data: string): Record<string, unknown> {
  const parsed = JSON.parse(data) as Record<string, unknown>;

  // JSON-RPC wrapper: { jsonrpc: "2.0", id: ..., result: { ... } }
  if (parsed.jsonrpc && parsed.result && typeof parsed.result === 'object') {
    return parsed.result as Record<string, unknown>;
  }

  return parsed;
}

/**
 * Detect event type from the event object when no SSE event: field is present.
 * Uses the 'kind' discriminator (v0.3) or structural detection.
 */
function detectEventType(obj: Record<string, unknown>): string {
  // v0.3 kind discriminator
  const kind = obj.kind as string | undefined;
  if (kind === 'status-update') return SSE_EVENT.STATUS_UPDATE;
  if (kind === 'artifact-update') return SSE_EVENT.ARTIFACT_UPDATE;
  if (kind === 'task') return SSE_EVENT.STATUS_UPDATE; // task events contain status
  if (kind === 'message') return SSE_EVENT.MESSAGE;

  // Structural detection
  if ('status' in obj && 'taskId' in obj && !('artifacts' in obj)) return SSE_EVENT.STATUS_UPDATE;
  if ('artifact' in obj) return SSE_EVENT.ARTIFACT_UPDATE;
  if ('status' in obj && 'id' in obj) return SSE_EVENT.STATUS_UPDATE; // Task object

  return SSE_EVENT.MESSAGE;
}

/**
 * Check if a status-like event represents a terminal state.
 */
function isTerminalStatus(obj: Record<string, unknown>): boolean {
  const status = obj.status as Record<string, unknown> | undefined;
  if (!status) return false;
  const state = (status.state as string ?? '').toLowerCase().replace('task_state_', '');
  return TERMINAL_STATES.has(state as TaskState);
}

/**
 * Parse an SSE Response stream into typed A2A events.
 */
export async function* parseSSEStream(
  response: Response,
  parser: ResponseParser,
): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
  const body = response.body;
  if (!body) {
    throw new Error('Response body is null — cannot parse SSE stream');
  }

  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const { events, remaining } = extractSSEEvents(buffer);
      buffer = remaining;

      for (const sseEvent of events) {
        // Format A: explicit event: field from a2x server
        if (sseEvent.event) {
          switch (sseEvent.event) {
            case SSE_EVENT.STATUS_UPDATE: {
              const raw = JSON.parse(sseEvent.data);
              yield parser.parseStatusUpdateEvent(raw);
              break;
            }
            case SSE_EVENT.ARTIFACT_UPDATE: {
              const raw = JSON.parse(sseEvent.data);
              yield parser.parseArtifactUpdateEvent(raw);
              break;
            }
            case SSE_EVENT.DONE:
              return;
            case SSE_EVENT.ERROR: {
              let message = 'Remote agent error';
              try {
                const errorData = JSON.parse(sseEvent.data);
                if (errorData.error) message = errorData.error;
              } catch {
                if (sseEvent.data) message = sseEvent.data;
              }
              throw new Error(message);
            }
          }
          continue;
        }

        // Format B: no event: field — detect type from data payload
        const obj = unwrapData(sseEvent.data);
        const eventType = detectEventType(obj);

        switch (eventType) {
          case SSE_EVENT.STATUS_UPDATE: {
            // Could be a Task object (kind: 'task') or a status-update
            if ('id' in obj && 'status' in obj && 'artifacts' in obj) {
              // Full Task object — emit as status update from its status
              yield parser.parseStatusUpdateEvent({
                taskId: obj.id,
                contextId: obj.contextId,
                status: obj.status,
                metadata: obj.metadata,
              });
            } else if ('id' in obj && 'status' in obj) {
              // Task object without artifacts
              yield parser.parseStatusUpdateEvent({
                taskId: obj.id,
                contextId: obj.contextId,
                status: obj.status,
                metadata: obj.metadata,
              });
            } else {
              yield parser.parseStatusUpdateEvent(obj);
            }
            // Stop on terminal status with final flag or terminal state
            const isFinal = (obj as Record<string, unknown>).final === true;
            if (isFinal && isTerminalStatus(obj)) return;
            break;
          }
          case SSE_EVENT.ARTIFACT_UPDATE: {
            yield parser.parseArtifactUpdateEvent(obj);
            break;
          }
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}
