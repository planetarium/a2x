/**
 * Layer 1: Task types derived from A2A protocol spec.
 */

import type { Artifact, Message } from './common.js';

// ─── Internal TaskState (version-agnostic) ───

export enum TaskState {
  SUBMITTED = 'submitted',
  WORKING = 'working',
  COMPLETED = 'completed',
  FAILED = 'failed',
  CANCELED = 'canceled',
  REJECTED = 'rejected',
  INPUT_REQUIRED = 'input-required',
  AUTH_REQUIRED = 'auth-required',
}

// ─── v1.0 Protocol Constants (for output mapping) ───

export enum TaskStateV10 {
  TASK_STATE_SUBMITTED = 'TASK_STATE_SUBMITTED',
  TASK_STATE_WORKING = 'TASK_STATE_WORKING',
  TASK_STATE_COMPLETED = 'TASK_STATE_COMPLETED',
  TASK_STATE_FAILED = 'TASK_STATE_FAILED',
  TASK_STATE_CANCELED = 'TASK_STATE_CANCELED',
  TASK_STATE_INPUT_REQUIRED = 'TASK_STATE_INPUT_REQUIRED',
  TASK_STATE_REJECTED = 'TASK_STATE_REJECTED',
  TASK_STATE_AUTH_REQUIRED = 'TASK_STATE_AUTH_REQUIRED',
}

// ─── Terminal States ───

export const TERMINAL_STATES: ReadonlySet<TaskState> = new Set([
  TaskState.COMPLETED,
  TaskState.FAILED,
  TaskState.CANCELED,
  TaskState.REJECTED,
]);

// ─── TaskState Mapping ───

export const TASK_STATE_TO_V10: ReadonlyMap<TaskState, TaskStateV10> = new Map([
  [TaskState.SUBMITTED, TaskStateV10.TASK_STATE_SUBMITTED],
  [TaskState.WORKING, TaskStateV10.TASK_STATE_WORKING],
  [TaskState.COMPLETED, TaskStateV10.TASK_STATE_COMPLETED],
  [TaskState.FAILED, TaskStateV10.TASK_STATE_FAILED],
  [TaskState.CANCELED, TaskStateV10.TASK_STATE_CANCELED],
  [TaskState.INPUT_REQUIRED, TaskStateV10.TASK_STATE_INPUT_REQUIRED],
  [TaskState.REJECTED, TaskStateV10.TASK_STATE_REJECTED],
  [TaskState.AUTH_REQUIRED, TaskStateV10.TASK_STATE_AUTH_REQUIRED],
]);

// ─── TaskStatus ───

export interface TaskStatus {
  state: TaskState;
  message?: Message;
  timestamp?: string; // ISO 8601
}

// ─── Task ───

export interface Task {
  id: string;
  contextId?: string;
  status: TaskStatus;
  artifacts?: Artifact[];
  history?: Message[];
  metadata?: Record<string, unknown>;
}

// ─── Streaming Events ───

export interface TaskStatusUpdateEvent {
  taskId: string;
  contextId: string;
  status: TaskStatus;
  metadata?: Record<string, unknown>;
}

export interface TaskArtifactUpdateEvent {
  taskId: string;
  contextId: string;
  artifact: Artifact;
  append?: boolean;
  lastChunk?: boolean;
  metadata?: Record<string, unknown>;
}
