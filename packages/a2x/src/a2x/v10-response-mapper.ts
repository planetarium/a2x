/**
 * Layer 3: V10ResponseMapper - maps internal response objects to v1.0 format.
 *
 * Transforms TaskState from lowercase to UPPER_SNAKE_CASE.
 * Transforms Role from lowercase to ROLE_UPPER format.
 * Strips `kind` fields (defensive, in case they are accidentally present).
 * Does not inject `history` or default artifact `name`.
 */

import type {
  Task,
  TaskStatus,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types/task.js';
import { TASK_STATE_TO_V10 } from '../types/task.js';
import type { TaskState } from '../types/task.js';
import type { Message, Part, Artifact, Role } from '../types/common.js';
import { ROLE_TO_V10 } from '../types/common.js';
import type { ResponseMapper } from './response-mapper.js';
import type {
  PushNotificationAuthenticationInfo,
  TaskPushNotificationConfig,
} from '../types/jsonrpc.js';

export class V10ResponseMapper implements ResponseMapper {
  readonly version = '1.0';

  mapTask(task: Task, _userMessage?: Message): unknown {
    const mapped: Record<string, unknown> = {
      id: task.id,
      ...(task.contextId !== undefined ? { contextId: task.contextId } : {}),
      status: this._mapStatus(task.status),
    };

    // Map artifacts (no default name injection)
    if (task.artifacts && task.artifacts.length > 0) {
      mapped.artifacts = task.artifacts.map((a) => this._mapArtifact(a));
    }

    // Pass through history if present (no injection)
    if (task.history && task.history.length > 0) {
      mapped.history = task.history.map((msg) => this._mapMessage(msg));
    }

    if (task.metadata !== undefined) {
      mapped.metadata = task.metadata;
    }

    return mapped;
  }

  mapStatusUpdateEvent(event: TaskStatusUpdateEvent): unknown {
    const mapped: Record<string, unknown> = {
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

  mapPushNotificationConfig(config: TaskPushNotificationConfig): unknown {
    const inner = config.pushNotificationConfig;
    const flat: Record<string, unknown> = {
      id: inner.id ?? '',
      taskId: config.taskId,
      url: inner.url,
    };
    if (inner.token !== undefined) flat.token = inner.token;
    if (inner.authentication !== undefined) {
      flat.authentication = this._mapAuthentication(inner.authentication);
    }
    return flat;
  }

  mapPushNotificationConfigList(configs: TaskPushNotificationConfig[]): unknown {
    return {
      configs: configs.map((c) => this.mapPushNotificationConfig(c)),
      nextPageToken: '',
    };
  }

  // ─── Private Helpers ───

  // v0.3 stores `{ schemes: string[], credentials? }` but v1.0
  // (`a2a-v1.0.0.json:466-483`, `a2a-v1.0.0.proto:325-329`) requires
  // `{ scheme: string, credentials? }` with `additionalProperties: false`.
  // Collapse to the first scheme on the wire — round-trip is lossy when v0.3
  // listed more than one, and the validator rejects empty arrays so
  // `schemes[0]` is always defined here.
  private _mapAuthentication(
    auth: PushNotificationAuthenticationInfo,
  ): Record<string, unknown> {
    const mapped: Record<string, unknown> = { scheme: auth.schemes[0] };
    if (auth.credentials !== undefined) {
      mapped.credentials = auth.credentials;
    }
    return mapped;
  }

  private _mapStateToV10(state: TaskState): string {
    const v10State = TASK_STATE_TO_V10.get(state);
    // Defensive: pass through if mapping is not found
    return v10State ?? state;
  }

  private _mapRoleToV10(role: Role): string {
    const v10Role = ROLE_TO_V10.get(role);
    return v10Role ?? role;
  }

  private _mapStatus(status: TaskStatus): Record<string, unknown> {
    const mapped: Record<string, unknown> = {
      state: this._mapStateToV10(status.state),
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
      messageId: message.messageId,
      role: this._mapRoleToV10(message.role),
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
    // Strip `kind` if accidentally present (defensive) and return clean object
    const { ...rest } = part as Record<string, unknown>;
    delete rest['kind'];
    return rest;
  }

  private _mapArtifact(artifact: Artifact): Record<string, unknown> {
    const mapped: Record<string, unknown> = {
      artifactId: artifact.artifactId,
      parts: artifact.parts.map((p) => this._mapPart(p)),
    };

    // Include name only if explicitly set (no default injection)
    if (artifact.name !== undefined) {
      mapped.name = artifact.name;
    }
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
