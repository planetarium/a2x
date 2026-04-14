/**
 * Layer 3: V03ResponseMapper - maps internal response objects to v0.3 format.
 *
 * Adds `kind` discriminators to Task, Message, Part, and streaming events.
 * Populates `history` with the user message when available.
 * Defaults artifact `name` to "response" when absent.
 * TaskState values remain lowercase (matching v0.3 spec).
 */

import type {
  Task,
  TaskStatus,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types/task.js';
import type { Message, Part, Artifact } from '../types/common.js';
import { isTextPart, isFilePart, isDataPart } from '../types/common.js';
import type { ResponseMapper } from './response-mapper.js';

export class V03ResponseMapper implements ResponseMapper {
  readonly version = '0.3';

  mapTask(task: Task, userMessage?: Message): unknown {
    const mapped: Record<string, unknown> = {
      kind: 'task',
      id: task.id,
      ...(task.contextId !== undefined ? { contextId: task.contextId } : {}),
      status: this._mapStatus(task.status),
    };

    // Build history with user message if available
    if (userMessage) {
      mapped.history = [this._mapMessage(userMessage)];
    } else if (task.history && task.history.length > 0) {
      mapped.history = task.history.map((msg) => this._mapMessage(msg));
    }

    // Map artifacts
    if (task.artifacts && task.artifacts.length > 0) {
      mapped.artifacts = task.artifacts.map((a) => this._mapArtifact(a));
    }

    if (task.metadata !== undefined) {
      mapped.metadata = task.metadata;
    }

    return mapped;
  }

  mapStatusUpdateEvent(event: TaskStatusUpdateEvent): unknown {
    const mapped: Record<string, unknown> = {
      kind: 'status-update',
      taskId: event.taskId,
      contextId: event.contextId,
      status: this._mapStatus(event.status),
    };

    if (event.metadata !== undefined) {
      mapped.metadata = event.metadata;
    }

    return mapped;
  }

  mapArtifactUpdateEvent(event: TaskArtifactUpdateEvent): unknown {
    const mapped: Record<string, unknown> = {
      kind: 'artifact-update',
      taskId: event.taskId,
      contextId: event.contextId,
      artifact: this._mapArtifact(event.artifact),
    };

    if (event.append !== undefined) {
      mapped.append = event.append;
    }
    if (event.lastChunk !== undefined) {
      mapped.lastChunk = event.lastChunk;
    }
    if (event.metadata !== undefined) {
      mapped.metadata = event.metadata;
    }

    return mapped;
  }

  // ─── Private Helpers ───

  private _mapStatus(status: TaskStatus): Record<string, unknown> {
    const mapped: Record<string, unknown> = {
      state: status.state, // already lowercase (internal format matches v0.3)
    };
    if (status.message) {
      mapped.message = this._mapMessage(status.message);
    }
    if (status.timestamp !== undefined) {
      mapped.timestamp = status.timestamp;
    }
    return mapped;
  }

  private _mapMessage(message: Message): Record<string, unknown> {
    const mapped: Record<string, unknown> = {
      kind: 'message',
      messageId: message.messageId,
      role: message.role,
      parts: message.parts.map((p) => this._mapPart(p)),
    };

    if (message.contextId !== undefined) {
      mapped.contextId = message.contextId;
    }
    if (message.taskId !== undefined) {
      mapped.taskId = message.taskId;
    }
    if (message.metadata !== undefined) {
      mapped.metadata = message.metadata;
    }
    if (message.extensions !== undefined) {
      mapped.extensions = message.extensions;
    }
    if (message.referenceTaskIds !== undefined) {
      mapped.referenceTaskIds = message.referenceTaskIds;
    }

    return mapped;
  }

  private _mapPart(part: Part): Record<string, unknown> {
    if (isTextPart(part)) {
      const mapped: Record<string, unknown> = { kind: 'text', text: part.text };
      if (part.mediaType !== undefined) mapped.mediaType = part.mediaType;
      if (part.metadata !== undefined) mapped.metadata = part.metadata;
      return mapped;
    }
    if (isFilePart(part)) {
      const mapped: Record<string, unknown> = { kind: 'file' };
      if (part.raw !== undefined) mapped.raw = part.raw;
      if (part.url !== undefined) mapped.url = part.url;
      if (part.filename !== undefined) mapped.filename = part.filename;
      if (part.mediaType !== undefined) mapped.mediaType = part.mediaType;
      if (part.metadata !== undefined) mapped.metadata = part.metadata;
      return mapped;
    }
    if (isDataPart(part)) {
      const mapped: Record<string, unknown> = { kind: 'data', data: part.data };
      if (part.mediaType !== undefined) mapped.mediaType = part.mediaType;
      if (part.metadata !== undefined) mapped.metadata = part.metadata;
      return mapped;
    }
    // Fallback: return as-is (should not happen with valid Part)
    return { ...(part as Record<string, unknown>) };
  }

  private _mapArtifact(artifact: Artifact): Record<string, unknown> {
    const mapped: Record<string, unknown> = {
      artifactId: artifact.artifactId,
      name: artifact.name ?? 'response', // default name for v0.3
      parts: artifact.parts.map((p) => this._mapPart(p)),
    };

    if (artifact.description !== undefined) {
      mapped.description = artifact.description;
    }
    if (artifact.metadata !== undefined) {
      mapped.metadata = artifact.metadata;
    }
    if (artifact.extensions !== undefined) {
      mapped.extensions = artifact.extensions;
    }

    return mapped;
  }
}
