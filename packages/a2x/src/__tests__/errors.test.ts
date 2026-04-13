import { describe, it, expect } from 'vitest';
import {
  A2AError,
  JSONParseError,
  InvalidRequestError,
  MethodNotFoundError,
  InvalidParamsError,
  InternalError,
  TaskNotFoundError,
  TaskNotCancelableError,
  PushNotificationNotSupportedError,
  UnsupportedOperationError,
  ContentTypeNotSupportedError,
  InvalidAgentResponseError,
  AuthenticatedExtendedCardNotConfiguredError,
  A2A_ERROR_CODES,
} from '../types/errors.js';

describe('Layer 1: A2A Error Classes', () => {
  it('JSONParseError should have correct code and convert to JSON-RPC error', () => {
    const err = new JSONParseError('bad json');
    expect(err).toBeInstanceOf(A2AError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(A2A_ERROR_CODES.JSON_PARSE_ERROR);
    expect(err.message).toBe('bad json');

    const jsonrpc = err.toJSONRPCError();
    expect(jsonrpc.code).toBe(-32700);
    expect(jsonrpc.message).toBe('bad json');
  });

  it('InvalidRequestError should have correct code', () => {
    const err = new InvalidRequestError();
    expect(err.code).toBe(A2A_ERROR_CODES.INVALID_REQUEST);
    expect(err.message).toBe('Invalid request');
  });

  it('MethodNotFoundError should have correct code', () => {
    const err = new MethodNotFoundError('unknown method');
    expect(err.code).toBe(A2A_ERROR_CODES.METHOD_NOT_FOUND);
  });

  it('InvalidParamsError should have correct code', () => {
    const err = new InvalidParamsError();
    expect(err.code).toBe(A2A_ERROR_CODES.INVALID_PARAMS);
  });

  it('InternalError should have correct code', () => {
    const err = new InternalError();
    expect(err.code).toBe(A2A_ERROR_CODES.INTERNAL_ERROR);
  });

  it('TaskNotFoundError should have correct code', () => {
    const err = new TaskNotFoundError('task-123');
    expect(err.code).toBe(A2A_ERROR_CODES.TASK_NOT_FOUND);
  });

  it('TaskNotCancelableError should have correct code', () => {
    const err = new TaskNotCancelableError();
    expect(err.code).toBe(A2A_ERROR_CODES.TASK_NOT_CANCELABLE);
  });

  it('PushNotificationNotSupportedError should have correct code', () => {
    const err = new PushNotificationNotSupportedError();
    expect(err.code).toBe(A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED);
  });

  it('UnsupportedOperationError should have correct code', () => {
    const err = new UnsupportedOperationError();
    expect(err.code).toBe(A2A_ERROR_CODES.UNSUPPORTED_OPERATION);
  });

  it('ContentTypeNotSupportedError should have correct code', () => {
    const err = new ContentTypeNotSupportedError();
    expect(err.code).toBe(A2A_ERROR_CODES.CONTENT_TYPE_NOT_SUPPORTED);
  });

  it('InvalidAgentResponseError should have correct code', () => {
    const err = new InvalidAgentResponseError();
    expect(err.code).toBe(A2A_ERROR_CODES.INVALID_AGENT_RESPONSE);
  });

  it('AuthenticatedExtendedCardNotConfiguredError should have correct code', () => {
    const err = new AuthenticatedExtendedCardNotConfiguredError();
    expect(err.code).toBe(A2A_ERROR_CODES.AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED);
  });

  it('should include data in JSON-RPC error when provided', () => {
    const err = new InternalError('oops', { detail: 'some detail' });
    const jsonrpc = err.toJSONRPCError();
    expect(jsonrpc.data).toEqual({ detail: 'some detail' });
  });

  it('should not include data in JSON-RPC error when not provided', () => {
    const err = new InternalError('oops');
    const jsonrpc = err.toJSONRPCError();
    expect(jsonrpc.data).toBeUndefined();
  });

  it('should set the error name to the class name', () => {
    const err = new TaskNotFoundError();
    expect(err.name).toBe('TaskNotFoundError');
  });
});
