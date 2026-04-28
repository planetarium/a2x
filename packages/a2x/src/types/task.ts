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
  // Spec a2a-v0.3 §TaskState (specification/a2a-v0.3.0.json:2440-2453) lists
  // `unknown` as a first-class state for peers that have lost track of a
  // task's true state (resubscribe after a crash, gateway that missed a
  // transition). Non-terminal — it signals "I don't know yet", not a
  // finalized outcome. Round-trips with v1.0's TASK_STATE_UNSPECIFIED.
  UNKNOWN = 'unknown',
}

// ─── v1.0 Protocol Constants (for output mapping) ───

export enum TaskStateV10 {
  // Proto default (value 0). v1.0 spec calls this "unknown or indeterminate
  // state" (a2a-v1.0.0.proto:188-189, a2a-v1.0.0.json:1885-1898) — semantic
  // match for v0.3's `unknown`, so the SDK rounds-trips them as a pair.
  TASK_STATE_UNSPECIFIED = 'TASK_STATE_UNSPECIFIED',
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
  [TaskState.UNKNOWN, TaskStateV10.TASK_STATE_UNSPECIFIED],
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
  /**
   * If true, this is the last status update expected for this task in the
   * stream. Spec a2a-v0.3 §TaskStatusUpdateEvent (top-level `final` field).
   * v1.0 dropped this field in favor of relying on the transport's
   * end-of-stream signal — the v1.0 response mapper omits it on the wire.
   */
  final?: boolean;
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
