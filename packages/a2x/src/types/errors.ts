/**
 * Layer 1: A2A error types and error code constants.
 */

import type { JSONRPCError } from './jsonrpc.js';

// ─── Error Code Constants (A2A spec) ───

export const A2A_ERROR_CODES = {
  JSON_PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  INVALID_AGENT_RESPONSE: -32006,
  AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED: -32007,
} as const;

// ─── Base A2A Error Class ───

export abstract class A2AError extends Error {
  abstract readonly code: number;
  readonly data?: unknown;

  constructor(message: string, data?: unknown) {
    super(message);
    this.name = this.constructor.name;
    this.data = data;
  }

  toJSONRPCError(): JSONRPCError {
    const error: JSONRPCError = {
      code: this.code,
      message: this.message,
    };
    if (this.data !== undefined) {
      error.data = this.data;
    }
    return error;
  }
}

// ─── Concrete Error Classes ───

export class JSONParseError extends A2AError {
  readonly code = A2A_ERROR_CODES.JSON_PARSE_ERROR;

  constructor(message = 'Parse error', data?: unknown) {
    super(message, data);
  }
}

export class InvalidRequestError extends A2AError {
  readonly code = A2A_ERROR_CODES.INVALID_REQUEST;

  constructor(message = 'Invalid request', data?: unknown) {
    super(message, data);
  }
}

export class MethodNotFoundError extends A2AError {
  readonly code = A2A_ERROR_CODES.METHOD_NOT_FOUND;

  constructor(message = 'Method not found', data?: unknown) {
    super(message, data);
  }
}

export class InvalidParamsError extends A2AError {
  readonly code = A2A_ERROR_CODES.INVALID_PARAMS;

  constructor(message = 'Invalid params', data?: unknown) {
    super(message, data);
  }
}

export class InternalError extends A2AError {
  readonly code = A2A_ERROR_CODES.INTERNAL_ERROR;

  constructor(message = 'Internal error', data?: unknown) {
    super(message, data);
  }
}

export class TaskNotFoundError extends A2AError {
  readonly code = A2A_ERROR_CODES.TASK_NOT_FOUND;

  constructor(message = 'Task not found', data?: unknown) {
    super(message, data);
  }
}

export class TaskNotCancelableError extends A2AError {
  readonly code = A2A_ERROR_CODES.TASK_NOT_CANCELABLE;

  constructor(message = 'Task is not cancelable', data?: unknown) {
    super(message, data);
  }
}

export class PushNotificationNotSupportedError extends A2AError {
  readonly code = A2A_ERROR_CODES.PUSH_NOTIFICATION_NOT_SUPPORTED;

  constructor(message = 'Push notification not supported', data?: unknown) {
    super(message, data);
  }
}

export class UnsupportedOperationError extends A2AError {
  readonly code = A2A_ERROR_CODES.UNSUPPORTED_OPERATION;

  constructor(message = 'Unsupported operation', data?: unknown) {
    super(message, data);
  }
}

export class ContentTypeNotSupportedError extends A2AError {
  readonly code = A2A_ERROR_CODES.CONTENT_TYPE_NOT_SUPPORTED;

  constructor(message = 'Content type not supported', data?: unknown) {
    super(message, data);
  }
}

export class InvalidAgentResponseError extends A2AError {
  readonly code = A2A_ERROR_CODES.INVALID_AGENT_RESPONSE;

  constructor(message = 'Invalid agent response', data?: unknown) {
    super(message, data);
  }
}

export class AuthenticatedExtendedCardNotConfiguredError extends A2AError {
  readonly code = A2A_ERROR_CODES.AUTHENTICATED_EXTENDED_CARD_NOT_CONFIGURED;

  constructor(
    message = 'Authenticated extended card not configured',
    data?: unknown,
  ) {
    super(message, data);
  }
}

