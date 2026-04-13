import { describe, it, expect } from 'vitest';
import {
  TaskState,
  TaskStateV10,
  TERMINAL_STATES,
  TASK_STATE_TO_V10,
  A2A_METHODS,
  A2A_ERROR_CODES,
} from '../types/index.js';

describe('Layer 1: Types', () => {
  describe('TaskState', () => {
    it('should define all task states', () => {
      expect(TaskState.SUBMITTED).toBe('submitted');
      expect(TaskState.WORKING).toBe('working');
      expect(TaskState.COMPLETED).toBe('completed');
      expect(TaskState.FAILED).toBe('failed');
      expect(TaskState.CANCELED).toBe('canceled');
      expect(TaskState.REJECTED).toBe('rejected');
      expect(TaskState.INPUT_REQUIRED).toBe('input-required');
      expect(TaskState.AUTH_REQUIRED).toBe('auth-required');
    });

    it('should define v1.0 task state mappings', () => {
      expect(TaskStateV10.TASK_STATE_SUBMITTED).toBe('TASK_STATE_SUBMITTED');
      expect(TaskStateV10.TASK_STATE_WORKING).toBe('TASK_STATE_WORKING');
    });

    it('should define terminal states', () => {
      expect(TERMINAL_STATES.has(TaskState.COMPLETED)).toBe(true);
      expect(TERMINAL_STATES.has(TaskState.FAILED)).toBe(true);
      expect(TERMINAL_STATES.has(TaskState.CANCELED)).toBe(true);
      expect(TERMINAL_STATES.has(TaskState.REJECTED)).toBe(true);
      expect(TERMINAL_STATES.has(TaskState.WORKING)).toBe(false);
      expect(TERMINAL_STATES.has(TaskState.SUBMITTED)).toBe(false);
    });

    it('should map internal states to v1.0 constants', () => {
      expect(TASK_STATE_TO_V10.get(TaskState.SUBMITTED)).toBe(
        TaskStateV10.TASK_STATE_SUBMITTED,
      );
      expect(TASK_STATE_TO_V10.get(TaskState.WORKING)).toBe(
        TaskStateV10.TASK_STATE_WORKING,
      );
    });
  });

  describe('A2A_METHODS', () => {
    it('should define all A2A JSON-RPC methods', () => {
      expect(A2A_METHODS.SEND_MESSAGE).toBe('message/send');
      expect(A2A_METHODS.STREAM_MESSAGE).toBe('message/stream');
      expect(A2A_METHODS.GET_TASK).toBe('tasks/get');
      expect(A2A_METHODS.CANCEL_TASK).toBe('tasks/cancel');
      expect(A2A_METHODS.RESUBSCRIBE).toBe('tasks/resubscribe');
    });
  });

  describe('A2A_ERROR_CODES', () => {
    it('should define all error codes', () => {
      expect(A2A_ERROR_CODES.JSON_PARSE_ERROR).toBe(-32700);
      expect(A2A_ERROR_CODES.INVALID_REQUEST).toBe(-32600);
      expect(A2A_ERROR_CODES.METHOD_NOT_FOUND).toBe(-32601);
      expect(A2A_ERROR_CODES.INVALID_PARAMS).toBe(-32602);
      expect(A2A_ERROR_CODES.INTERNAL_ERROR).toBe(-32603);
      expect(A2A_ERROR_CODES.TASK_NOT_FOUND).toBe(-32001);
      expect(A2A_ERROR_CODES.TASK_NOT_CANCELABLE).toBe(-32002);
      expect(A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED).toBe(-32003);
      expect(A2A_ERROR_CODES.UNSUPPORTED_OPERATION).toBe(-32004);
      expect(A2A_ERROR_CODES.CONTENT_TYPE_NOT_SUPPORTED).toBe(-32005);
      expect(A2A_ERROR_CODES.INVALID_AGENT_RESPONSE).toBe(-32006);
      expect(A2A_ERROR_CODES.AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED).toBe(-32007);
    });
  });
});
