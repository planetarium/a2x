/**
 * Layer 4: DefaultRequestHandler - framework-agnostic JSON-RPC handler.
 *
 * Unified `handle()` entry point: returns a `JSONRPCResponse` for sync
 * methods or an `AsyncGenerator` for streaming methods.  The caller
 * (Next.js route, Express middleware, etc.) checks `Symbol.asyncIterator`
 * on the result to decide between a JSON response and an SSE stream.
 */

import type { A2XAgent } from '../a2x/a2x-agent.js';
import type {
  JSONRPCRequest,
  JSONRPCResponse,
  SendMessageParams,
  TaskIdParams,
} from '../types/jsonrpc.js';
import { A2A_METHODS } from '../types/jsonrpc.js';
import type { AgentCardV03, AgentCardV10 } from '../types/agent-card.js';
import type { Task } from '../types/task.js';
import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types/task.js';
import { TERMINAL_STATES, TaskState } from '../types/task.js';
import {
  InternalError,
  InvalidParamsError,
  InvalidRequestError,
  JSONParseError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
  type A2AError,
} from '../types/errors.js';
import { StreamingMode } from '../a2x/agent-executor.js';
import { JsonRpcRouter } from './jsonrpc-router.js';
import type { ResponseMapper } from '../a2x/response-mapper.js';
import { ResponseMapperFactory } from '../a2x/response-mapper.js';

/** Return type of `handle()`. */
export type HandleResult =
  | JSONRPCResponse
  | AsyncGenerator<unknown>;

export class DefaultRequestHandler {
  private readonly a2xAgent: A2XAgent;
  private readonly router: JsonRpcRouter;
  private readonly responseMapper: ResponseMapper;

  constructor(a2xAgent: A2XAgent) {
    this.a2xAgent = a2xAgent;
    this.router = new JsonRpcRouter();
    this.responseMapper = ResponseMapperFactory.getMapper(a2xAgent.protocolVersion);
    this._registerRoutes();
  }

  /**
   * Handle a JSON-RPC request body.
   *
   * Returns a `JSONRPCResponse` for synchronous methods (`message/send`,
   * `tasks/get`, `tasks/cancel`) or an `AsyncGenerator` for streaming
   * methods (`message/stream`).
   *
   * The caller inspects the return value:
   * ```ts
   * const result = await handler.handle(body);
   * if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
   *   // stream → convert to SSE Response
   * } else {
   *   // sync → return as JSON
   * }
   * ```
   */
  async handle(
    body: JSONRPCRequest | string | unknown,
  ): Promise<HandleResult> {
    let request: JSONRPCRequest;

    // Parse if string
    if (typeof body === 'string') {
      try {
        request = JSON.parse(body) as JSONRPCRequest;
      } catch {
        const error = new JSONParseError();
        return {
          jsonrpc: '2.0',
          id: null,
          error: error.toJSONRPCError(),
        };
      }
    } else {
      request = body as JSONRPCRequest;
    }

    // Validate basic JSON-RPC structure
    if (
      !request ||
      request.jsonrpc !== '2.0' ||
      !request.method ||
      request.id === undefined
    ) {
      const error = new InvalidRequestError('Invalid JSON-RPC 2.0 request');
      return {
        jsonrpc: '2.0',
        id: request?.id ?? null,
        error: error.toJSONRPCError(),
      };
    }

    // Streaming method → return AsyncGenerator
    if (this.router.isStreamMethod(request.method)) {
      try {
        return this.router.routeStream(request) as AsyncGenerator<unknown>;
      } catch (err) {
        return this._toErrorResponse(request.id, err);
      }
    }

    // Synchronous method → return JSONRPCResponse
    try {
      return await this.router.route(request);
    } catch (err) {
      return this._toErrorResponse(request.id, err);
    }
  }

  /**
   * Get the AgentCard for a specific protocol version.
   */
  getAgentCard(version?: string): AgentCardV03 | AgentCardV10 {
    return this.a2xAgent.getAgentCard(version);
  }

  // ─── Private: Route Registration ───

  private _registerRoutes(): void {
    // message/send
    this.router.registerMethod(
      A2A_METHODS.SEND_MESSAGE,
      async (params) => {
        const sendParams = this._validateSendMessageParams(params);
        return this._handleSendMessage(sendParams);
      },
    );

    // message/stream (SSE)
    this.router.registerStreamMethod(
      A2A_METHODS.STREAM_MESSAGE,
      (params) => {
        const sendParams = this._validateSendMessageParams(params);
        return this._handleStreamMessage(sendParams);
      },
    );

    // tasks/get
    this.router.registerMethod(
      A2A_METHODS.GET_TASK,
      async (params) => {
        const taskParams = this._validateTaskIdParams(params);
        return this._handleGetTask(taskParams);
      },
    );

    // tasks/cancel
    this.router.registerMethod(
      A2A_METHODS.CANCEL_TASK,
      async (params) => {
        const taskParams = this._validateTaskIdParams(params);
        return this._handleCancelTask(taskParams);
      },
    );
  }

  // ─── Private: Method Handlers ───

  private async _handleSendMessage(params: SendMessageParams): Promise<unknown> {
    const task = await this.a2xAgent.taskStore.createTask({
      contextId: params.message.contextId,
      metadata: params.metadata,
    });

    const completedTask = await this.a2xAgent.agentExecutor.execute(
      task,
      params.message,
    );

    return this.responseMapper.mapTask(completedTask, params.message);
  }

  private async *_handleStreamMessage(
    params: SendMessageParams,
  ): AsyncGenerator<unknown> {
    if (
      this.a2xAgent.agentExecutor.runConfig.streamingMode ===
      StreamingMode.NONE
    ) {
      throw new UnsupportedOperationError(
        'Streaming is not supported by this agent',
      );
    }

    const task = await this.a2xAgent.taskStore.createTask({
      contextId: params.message.contextId,
      metadata: params.metadata,
    });

    const eventStream = this.a2xAgent.agentExecutor.executeStream(
      task,
      params.message,
    );

    for await (const event of eventStream) {
      // Update task in store for non-terminal status events.
      // Terminal states are already applied by AgentExecutor (same object
      // reference), so calling updateTask would hit the guard.
      if (
        'status' in event &&
        !TERMINAL_STATES.has(event.status.state)
      ) {
        await this.a2xAgent.taskStore.updateTask(task.id, {
          status: event.status,
        });
      }
      if ('status' in event) {
        yield this.responseMapper.mapStatusUpdateEvent(event as TaskStatusUpdateEvent);
      } else {
        yield this.responseMapper.mapArtifactUpdateEvent(event as TaskArtifactUpdateEvent);
      }
    }
  }

  private async _handleGetTask(params: TaskIdParams): Promise<unknown> {
    const task = await this.a2xAgent.taskStore.getTask(params.id);
    if (!task) {
      throw new TaskNotFoundError(`Task not found: ${params.id}`);
    }
    return this.responseMapper.mapTask(task);
  }

  private async _handleCancelTask(params: TaskIdParams): Promise<unknown> {
    const task = await this.a2xAgent.taskStore.getTask(params.id);
    if (!task) {
      throw new TaskNotFoundError(`Task not found: ${params.id}`);
    }

    if (TERMINAL_STATES.has(task.status.state)) {
      throw new TaskNotCancelableError(
        `Task '${params.id}' is in terminal state '${task.status.state}' and cannot be canceled`,
      );
    }

    const canceledTask = await this.a2xAgent.agentExecutor.cancel(task);

    await this.a2xAgent.taskStore.updateTask(task.id, {
      status: canceledTask.status,
    });

    return this.responseMapper.mapTask(canceledTask);
  }

  // ─── Private: Helpers ───

  private _toErrorResponse(
    id: string | number | null,
    err: unknown,
  ): JSONRPCResponse {
    if (err && typeof err === 'object' && 'toJSONRPCError' in err) {
      return {
        jsonrpc: '2.0',
        id,
        error: (err as A2AError).toJSONRPCError(),
      };
    }
    const internalError = new InternalError(
      err instanceof Error ? err.message : 'Internal error',
    );
    return {
      jsonrpc: '2.0',
      id,
      error: internalError.toJSONRPCError(),
    };
  }

  private _validateSendMessageParams(params: unknown): SendMessageParams {
    if (
      !params ||
      typeof params !== 'object' ||
      !('message' in params)
    ) {
      throw new InvalidParamsError(
        'SendMessage requires a "message" parameter',
      );
    }

    const p = params as Record<string, unknown>;
    const message = p.message as Record<string, unknown>;

    if (!message || typeof message !== 'object' || !message.role || !message.parts) {
      throw new InvalidParamsError(
        'SendMessage: message must have "role" and "parts" fields',
      );
    }

    return params as SendMessageParams;
  }

  private _validateTaskIdParams(params: unknown): TaskIdParams {
    if (
      !params ||
      typeof params !== 'object' ||
      !('id' in params)
    ) {
      throw new InvalidParamsError('Task method requires an "id" parameter');
    }

    const p = params as Record<string, unknown>;
    if (typeof p.id !== 'string' || p.id.trim() === '') {
      throw new InvalidParamsError('Task "id" must be a non-empty string');
    }

    return params as TaskIdParams;
  }
}
