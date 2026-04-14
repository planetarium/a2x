/**
 * Client-side response parsing.
 * Inverse of server-side ResponseMapper — normalizes wire format back to internal types.
 */

import type { Task } from '../types/task.js';
import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types/task.js';
import { TaskState, TASK_STATE_TO_V10 } from '../types/task.js';
import type { ProtocolVersion } from './agent-card-resolver.js';

// ─── Reverse map: v1.0 UPPER_SNAKE_CASE → internal lowercase TaskState ───

const V10_STATE_TO_INTERNAL = new Map<string, TaskState>();
for (const [internal, v10] of TASK_STATE_TO_V10) {
  V10_STATE_TO_INTERNAL.set(v10, internal);
}

// ─── ResponseParser interface ───

export interface ResponseParser {
  parseTask(raw: unknown): Task;
  parseStatusUpdateEvent(raw: unknown): TaskStatusUpdateEvent;
  parseArtifactUpdateEvent(raw: unknown): TaskArtifactUpdateEvent;
}

// ─── Shared utilities ───

function stripKind<T extends Record<string, unknown>>(obj: T): T {
  if ('kind' in obj) {
    const { kind: _, ...rest } = obj;
    return rest as T;
  }
  return obj;
}

/**
 * Normalize a v0.3 Part to internal flat format.
 * Strips `kind` and converts nested FilePart `{ file: { uri, bytes, mimeType, name } }`
 * to flat `{ url, raw, mediaType, filename }`.
 */
function normalizeV03Part(part: Record<string, unknown>): Record<string, unknown> {
  const stripped = stripKind(part);

  // v0.3 FilePart: { file: { uri?, bytes?, mimeType?, name? } } → flat
  if ('file' in stripped && typeof stripped.file === 'object' && stripped.file !== null) {
    const file = stripped.file as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    if (file.uri) result.url = file.uri;
    if (file.bytes) result.raw = file.bytes;
    if (file.mimeType) result.mediaType = file.mimeType;
    if (file.name) result.filename = file.name;
    if (stripped.metadata) result.metadata = stripped.metadata;
    return result;
  }

  return stripped;
}

function stripKindDeep(obj: Record<string, unknown>): Record<string, unknown> {
  const result = stripKind(obj);

  // Strip kind from nested status.message
  if (result.status && typeof result.status === 'object') {
    const status = result.status as Record<string, unknown>;
    if (status.message && typeof status.message === 'object') {
      status.message = stripKind(status.message as Record<string, unknown>);
      const msg = status.message as Record<string, unknown>;
      if (Array.isArray(msg.parts)) {
        msg.parts = msg.parts.map((p: unknown) =>
          typeof p === 'object' && p !== null
            ? normalizeV03Part(p as Record<string, unknown>)
            : p,
        );
      }
    }
  }

  // Strip kind from artifacts
  if (Array.isArray(result.artifacts)) {
    result.artifacts = result.artifacts.map((a: unknown) => {
      if (typeof a !== 'object' || a === null) return a;
      const artifact = stripKind(a as Record<string, unknown>);
      if (Array.isArray(artifact.parts)) {
        artifact.parts = artifact.parts.map((p: unknown) =>
          typeof p === 'object' && p !== null
            ? normalizeV03Part(p as Record<string, unknown>)
            : p,
        );
      }
      return artifact;
    });
  }

  // Strip kind from history messages
  if (Array.isArray(result.history)) {
    result.history = result.history.map((m: unknown) => {
      if (typeof m !== 'object' || m === null) return m;
      const msg = stripKind(m as Record<string, unknown>);
      if (Array.isArray(msg.parts)) {
        msg.parts = msg.parts.map((p: unknown) =>
          typeof p === 'object' && p !== null
            ? normalizeV03Part(p as Record<string, unknown>)
            : p,
        );
      }
      return msg;
    });
  }

  return result;
}

// ─── V03ResponseParser ───

class V03ResponseParser implements ResponseParser {
  parseTask(raw: unknown): Task {
    const obj = raw as Record<string, unknown>;
    return stripKindDeep(obj) as unknown as Task;
  }

  parseStatusUpdateEvent(raw: unknown): TaskStatusUpdateEvent {
    const obj = raw as Record<string, unknown>;
    return stripKindDeep(obj) as unknown as TaskStatusUpdateEvent;
  }

  parseArtifactUpdateEvent(raw: unknown): TaskArtifactUpdateEvent {
    const obj = raw as Record<string, unknown>;
    const result = stripKind(obj);

    // Strip kind from artifact and its parts
    if (result.artifact && typeof result.artifact === 'object') {
      const artifact = stripKind(result.artifact as Record<string, unknown>);
      if (Array.isArray(artifact.parts)) {
        artifact.parts = artifact.parts.map((p: unknown) =>
          typeof p === 'object' && p !== null
            ? normalizeV03Part(p as Record<string, unknown>)
            : p,
        );
      }
      result.artifact = artifact;
    }

    return result as unknown as TaskArtifactUpdateEvent;
  }
}

// ─── V10ResponseParser ───

function convertV10State(state: string): TaskState {
  const mapped = V10_STATE_TO_INTERNAL.get(state);
  if (mapped) return mapped;

  // If already lowercase (internal format), validate and return
  const values = Object.values(TaskState) as string[];
  if (values.includes(state)) return state as TaskState;

  throw new Error(`Unknown task state: ${state}`);
}

function convertV10TaskState(obj: Record<string, unknown>): void {
  if (obj.status && typeof obj.status === 'object') {
    const status = obj.status as Record<string, unknown>;
    if (typeof status.state === 'string') {
      status.state = convertV10State(status.state);
    }
  }
}

class V10ResponseParser implements ResponseParser {
  parseTask(raw: unknown): Task {
    const obj = { ...(raw as Record<string, unknown>) };
    convertV10TaskState(obj);
    return obj as unknown as Task;
  }

  parseStatusUpdateEvent(raw: unknown): TaskStatusUpdateEvent {
    const obj = { ...(raw as Record<string, unknown>) };
    convertV10TaskState(obj);
    return obj as unknown as TaskStatusUpdateEvent;
  }

  parseArtifactUpdateEvent(raw: unknown): TaskArtifactUpdateEvent {
    return raw as TaskArtifactUpdateEvent;
  }
}

// ─── Factory ───

const parsers: Record<ProtocolVersion, ResponseParser> = {
  '0.3': new V03ResponseParser(),
  '1.0': new V10ResponseParser(),
};

export function getResponseParser(version: ProtocolVersion): ResponseParser {
  return parsers[version];
}
