/**
 * Layer 1: JSON-RPC 2.0 types and A2A method constants.
 */

import type { Message } from './common.js';

// ─── JSON-RPC 2.0 Core Types ───

export interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: string | number;
  method: string;
  params?: unknown;
}

export interface JSONRPCSuccessResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result: unknown;
}

export interface JSONRPCErrorResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  error: JSONRPCError;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: unknown;
}

export type JSONRPCResponse = JSONRPCSuccessResponse | JSONRPCErrorResponse;

// ─── A2A JSON-RPC Methods ───

export const A2A_METHODS = {
  SEND_MESSAGE: 'message/send',
  STREAM_MESSAGE: 'message/stream',
  GET_TASK: 'tasks/get',
  CANCEL_TASK: 'tasks/cancel',
  RESUBSCRIBE: 'tasks/resubscribe',
  SET_PUSH_CONFIG: 'tasks/pushNotificationConfig/set',
  GET_PUSH_CONFIG: 'tasks/pushNotificationConfig/get',
  LIST_PUSH_CONFIGS: 'tasks/pushNotificationConfig/list',
  DELETE_PUSH_CONFIG: 'tasks/pushNotificationConfig/delete',
  GET_EXTENDED_CARD: 'agent/getAuthenticatedExtendedCard',
} as const;

// ─── SendMessage Parameters ───

export interface SendMessageParams {
  message: Message;
  configuration?: SendMessageConfiguration;
  metadata?: Record<string, unknown>;
}

/**
 * Spec a2a-v0.3 §MessageSendConfiguration. Field names match the spec
 * verbatim. `blocking` (true → wait for terminal state) replaces the
 * old SDK-private `returnImmediately` (which was the inverse). The
 * `pushNotificationConfig` field lets clients register a webhook in
 * the same call that creates the task — no follow-up
 * `tasks/pushNotificationConfig/set` round-trip needed.
 */
export interface SendMessageConfiguration {
  acceptedOutputModes?: string[];
  historyLength?: number;
  blocking?: boolean;
  pushNotificationConfig?: PushNotificationConfig;
}

// ─── Task Query Parameters ───

export interface TaskIdParams {
  id: string;
  metadata?: Record<string, unknown>;
}

/**
 * Spec a2a-v0.3 §TaskQueryParams — the params shape for `tasks/get`.
 * Adds `historyLength` to bound how many history entries the server
 * returns; clients use this to avoid pulling the full history on every
 * poll of a long-running conversation.
 */
export interface TaskQueryParams {
  id: string;
  historyLength?: number;
  metadata?: Record<string, unknown>;
}

// ─── Push Notification Config Types ───

export interface PushNotificationConfig {
  id: string;
  url: string;
  token?: string;
  authentication?: PushNotificationAuthenticationInfo;
}

export interface PushNotificationAuthenticationInfo {
  schemes: string[];
  credentials?: string;
}

/**
 * Spec-canonical v0.3 TaskPushNotificationConfig shape:
 *   { taskId, pushNotificationConfig }
 *
 * The config identifier lives at `pushNotificationConfig.id` and is
 * optional per spec; server-side handlers assign a UUID when clients omit
 * it so the store can key it. v1.0 wire responses are produced by the
 * response mapper (flattened shape) — do not add top-level `id` here.
 */
export interface TaskPushNotificationConfig {
  taskId: string;
  pushNotificationConfig: PushNotificationConfig;
}

// ─── Delete Push Notification Config Parameters ───

/**
 * Version-agnostic internal representation for delete push notification config.
 *
 * v0.3 wire format: { id: taskId, pushNotificationConfigId: configId }
 * v1.0 wire format: { taskId: taskId, id: configId }
 *
 * The validator normalizes both formats into this unified shape.
 */
export interface DeletePushNotificationConfigParams {
  taskId: string;
  configId: string;
  metadata?: Record<string, unknown>;
}

// ─── Get Push Notification Config Parameters ───

/**
 * Version-agnostic internal representation for get push notification config.
 *
 * v0.3 wire format: anyOf(TaskIdParams, GetTaskPushNotificationConfigParams)
 *   - TaskIdParams: { id: taskId }  → configId omitted (return first config)
 *   - Get...Params: { id: taskId, pushNotificationConfigId?: configId }
 * v1.0 wire format: { taskId: taskId, id: configId }
 *
 * `configId` is optional because v0.3 spec marks `pushNotificationConfigId`
 * optional; handlers fall back to the first stored config when absent.
 */
export interface GetPushNotificationConfigParams {
  taskId: string;
  configId?: string;
  metadata?: Record<string, unknown>;
}

// ─── List Push Notification Configs Parameters ───

/**
 * Version-agnostic internal representation for list push notification configs.
 *
 * v0.3 wire format: { id: taskId }
 * v1.0 wire format: { taskId, pageSize?, pageToken? }
 *
 * The validator normalizes both formats into this unified shape. Pagination
 * fields are accepted on the wire but ignored in Phase A.
 */
export interface ListPushNotificationConfigsParams {
  taskId: string;
  metadata?: Record<string, unknown>;
}
