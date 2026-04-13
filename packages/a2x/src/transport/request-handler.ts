/**
 * Layer 4: DefaultRequestHandler - framework-agnostic JSON-RPC handler.
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
import { createSSEStream } from './sse-handler.js';

export class DefaultRequestHandler {
  private readonly a2xAgent: A2XAgent;
  private readonly router: JsonRpcRouter;

  constructor(a2xAgent: A2XAgent) {
    this.a2xAgent = a2xAgent;
    this.router = new JsonRpcRouter();
    this._registerRoutes();
  }

  /**
   * Handle a JSON-RPC request body (already parsed or as a string).
   */
  async handle(body: JSONRPCRequest | string): Promise<JSONRPCResponse> {
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
      request = body;
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

    // Check if this is a streaming method
    if (this.router.isStreamMethod(request.method)) {
      // For streaming methods called via handle(), return an error
      // suggesting they use handleStream() instead
      const error = new UnsupportedOperationError(
        `Method '${request.method}' requires streaming. Use handleStream() instead.`,
      );
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: error.toJSONRPCError(),
      };
    }

    try {
      return await this.router.route(request);
    } catch (err) {
      if (err && typeof err === 'object' && 'toJSONRPCError' in err) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: (err as A2AError).toJSONRPCError(),
        };
      }
      const internalError = new InternalError(
        err instanceof Error ? err.message : 'Internal error',
      );
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: internalError.toJSONRPCError(),
      };
    }
  }

  /**
   * Handle a streaming JSON-RPC request, returning a ReadableStream of SSE events.
   */
  handleStream(body: JSONRPCRequest | string): ReadableStream {
    let request: JSONRPCRequest;

    if (typeof body === 'string') {
      try {
        request = JSON.parse(body) as JSONRPCRequest;
      } catch {
        throw new JSONParseError();
      }
    } else {
      request = body;
    }

    if (
      !request ||
      request.jsonrpc !== '2.0' ||
      !request.method ||
      request.id === undefined
    ) {
      throw new InvalidRequestError('Invalid JSON-RPC 2.0 request');
    }

    return this.router.routeStream(request);
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

  private async _handleSendMessage(params: SendMessageParams): Promise<Task> {
    // Create a task
    const task = await this.a2xAgent.taskStore.createTask({
      contextId: params.message.contextId,
      metadata: params.metadata,
    });

    // Execute synchronously.
    // The execute() method mutates the task object directly (same reference
    // stored in TaskStore), so we do not need a separate updateTask() call.
    const completedTask = await this.a2xAgent.agentExecutor.execute(
      task,
      params.message,
    );

    return completedTask;
  }

  private _handleStreamMessage(params: SendMessageParams): ReadableStream {
    // Check if streaming is supported
    if (
      this.a2xAgent.agentExecutor.runConfig.streamingMode ===
      StreamingMode.NONE
    ) {
      throw new UnsupportedOperationError(
        'Streaming is not supported by this agent',
      );
    }

    // We need to create the task synchronously and then stream
    // Use an async IIFE wrapped in the SSE stream
    const a2xAgent = this.a2xAgent;

    const taskPromise = a2xAgent.taskStore.createTask({
      contextId: params.message.contextId,
      metadata: params.metadata,
    });

    // Create an async generator that first creates the task, then streams events
    async function* streamEvents() {
      const task = await taskPromise;
      const eventStream = a2xAgent.agentExecutor.executeStream(
        task,
        params.message,
      );

      for await (const event of eventStream) {
        // Update task in store for status events
        if ('status' in event) {
          await a2xAgent.taskStore.updateTask(task.id, {
            status: event.status,
          });
        }
        yield event;
      }
    }

    return createSSEStream(streamEvents());
  }

  private async _handleGetTask(params: TaskIdParams): Promise<Task> {
    const task = await this.a2xAgent.taskStore.getTask(params.id);
    if (!task) {
      throw new TaskNotFoundError(`Task not found: ${params.id}`);
    }
    return task;
  }

  private async _handleCancelTask(params: TaskIdParams): Promise<Task> {
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

    return canceledTask;
  }

  // ─── Private: Param Validation ───

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
