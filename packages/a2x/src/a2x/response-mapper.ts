/**
 * Layer 3: ResponseMapper interface and factory.
 *
 * Mirrors the AgentCardMapper / AgentCardMapperFactory pattern
 * for version-specific JSON-RPC response and SSE event mapping.
 */

import type { Task, TaskStatusUpdateEvent, TaskArtifactUpdateEvent } from '../types/task.js';
import type { Message } from '../types/common.js';
import type { TaskPushNotificationConfig } from '../types/jsonrpc.js';

// ─── ResponseMapper Interface ───

export interface ResponseMapper {
  readonly version: string;

  /**
   * Map an internal Task to its version-specific output representation.
   * @param task - The internal Task object.
   * @param userMessage - The user's original message (for v0.3 history injection).
   */
  mapTask(task: Task, userMessage?: Message): unknown;

  /**
   * Map an internal TaskStatusUpdateEvent to its version-specific output.
   */
  mapStatusUpdateEvent(event: TaskStatusUpdateEvent): unknown;

  /**
   * Map an internal TaskArtifactUpdateEvent to its version-specific output.
   */
  mapArtifactUpdateEvent(event: TaskArtifactUpdateEvent): unknown;

  /**
   * Map a single push notification config to the version-specific wire shape.
   * v0.3: `{ taskId, pushNotificationConfig }` (nested).
   * v1.0: `{ id, taskId, url, token?, authentication?, tenant }` (flattened).
   */
  mapPushNotificationConfig(config: TaskPushNotificationConfig): unknown;

  /**
   * Map a list of push notification configs to the version-specific wire shape.
   * v0.3: bare array.
   * v1.0: `{ configs: [...], nextPageToken: "" }` (paginated object).
   */
  mapPushNotificationConfigList(configs: TaskPushNotificationConfig[]): unknown;
}

// ─── ResponseMapperFactory ───

export class ResponseMapperFactory {
  private static readonly mappers = new Map<string, ResponseMapper>();

  static register(version: string, mapper: ResponseMapper): void {
    ResponseMapperFactory.mappers.set(version, mapper);
  }

  static getMapper(version: string): ResponseMapper {
    const mapper = ResponseMapperFactory.mappers.get(version);
    if (!mapper) {
      throw new Error(
        `ResponseMapperFactory: no mapper registered for version '${version}'. ` +
          `Supported versions: ${ResponseMapperFactory.getSupportedVersions().join(', ')}`,
      );
    }
    return mapper;
  }

  static getSupportedVersions(): string[] {
    return Array.from(ResponseMapperFactory.mappers.keys());
  }
}
