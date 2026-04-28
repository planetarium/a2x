import { describe, it, expect } from 'vitest';
import {
  TaskState,
  TaskStateV10,
  TERMINAL_STATES,
  TASK_STATE_TO_V10,
  A2A_METHODS,
  A2A_ERROR_CODES,
  isTextPart,
  isFilePart,
  isDataPart,
  type Part,
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
      expect(TaskState.UNKNOWN).toBe('unknown');
    });

    it('should define v1.0 task state mappings', () => {
      expect(TaskStateV10.TASK_STATE_SUBMITTED).toBe('TASK_STATE_SUBMITTED');
      expect(TaskStateV10.TASK_STATE_WORKING).toBe('TASK_STATE_WORKING');
      expect(TaskStateV10.TASK_STATE_UNSPECIFIED).toBe('TASK_STATE_UNSPECIFIED');
    });

    it('should define terminal states', () => {
      expect(TERMINAL_STATES.has(TaskState.COMPLETED)).toBe(true);
      expect(TERMINAL_STATES.has(TaskState.FAILED)).toBe(true);
      expect(TERMINAL_STATES.has(TaskState.CANCELED)).toBe(true);
      expect(TERMINAL_STATES.has(TaskState.REJECTED)).toBe(true);
      expect(TERMINAL_STATES.has(TaskState.WORKING)).toBe(false);
      expect(TERMINAL_STATES.has(TaskState.SUBMITTED)).toBe(false);
      // `unknown` is non-terminal — peer may resync and transition out of it.
      expect(TERMINAL_STATES.has(TaskState.UNKNOWN)).toBe(false);
    });

    it('should map internal states to v1.0 constants', () => {
      expect(TASK_STATE_TO_V10.get(TaskState.SUBMITTED)).toBe(
        TaskStateV10.TASK_STATE_SUBMITTED,
      );
      expect(TASK_STATE_TO_V10.get(TaskState.WORKING)).toBe(
        TaskStateV10.TASK_STATE_WORKING,
      );
      // v0.3 `unknown` ↔ v1.0 `TASK_STATE_UNSPECIFIED` (proto default 0,
      // documented in v1.0 as "unknown or indeterminate state").
      expect(TASK_STATE_TO_V10.get(TaskState.UNKNOWN)).toBe(
        TaskStateV10.TASK_STATE_UNSPECIFIED,
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

  describe('Part type guards', () => {
    it('isTextPart matches text-bearing parts only', () => {
      expect(isTextPart({ text: 'hi' } as Part)).toBe(true);
      expect(isTextPart({ raw: 'aGk=' } as Part)).toBe(false);
      expect(isTextPart({ data: { x: 1 } } as Part)).toBe(false);
    });

    it('isDataPart matches data-bearing parts only', () => {
      expect(isDataPart({ data: { x: 1 } } as Part)).toBe(true);
      expect(isDataPart({ text: 'hi' } as Part)).toBe(false);
    });

    // Issue #142 fix 5: a v0.3-spec FilePart is `{ kind: 'file', file: {...} }`
    // (a2a-v0.3.0.json:828-861). The pre-fix guard only recognized the
    // SDK's flat `{ raw | url }` form, so a spec-conformant input fell
    // through every guard as `none`.
    it('isFilePart recognizes both the SDK flat shape and the v0.3 nested wire shape', () => {
      // Flat / internal
      expect(isFilePart({ raw: 'aGk=' } as Part)).toBe(true);
      expect(isFilePart({ url: 'https://example.com/x' } as Part)).toBe(true);
      // v0.3 nested wire shape
      expect(
        isFilePart({
          kind: 'file',
          file: { bytes: 'aGk=', mimeType: 'text/plain' },
        } as unknown as Part),
      ).toBe(true);
      expect(
        isFilePart({
          kind: 'file',
          file: { uri: 'https://example.com/x' },
        } as unknown as Part),
      ).toBe(true);
      // Negatives
      expect(isFilePart({ text: 'hi' } as Part)).toBe(false);
      expect(isFilePart({ data: { x: 1 } } as Part)).toBe(false);
      expect(isFilePart({ kind: 'file' } as unknown as Part)).toBe(false);
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
