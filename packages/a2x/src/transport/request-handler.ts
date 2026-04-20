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
  DeletePushNotificationConfigParams,
} from '../types/jsonrpc.js';
import { A2A_METHODS } from '../types/jsonrpc.js';
import type { AgentCardV03, AgentCardV10 } from '../types/agent-card.js';
import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types/task.js';
import { TERMINAL_STATES } from '../types/task.js';
import {
  AuthenticationRequiredError,
  InternalError,
  InvalidParamsError,
  InvalidRequestError,
  JSONParseError,
  PushNotificationNotSupportedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
  type A2AError,
} from '../types/errors.js';
import { StreamingMode } from '../a2x/agent-executor.js';
import { JsonRpcRouter } from './jsonrpc-router.js';
import type { ResponseMapper } from '../a2x/response-mapper.js';
import { ResponseMapperFactory } from '../a2x/response-mapper.js';
import type { RequestContext, AuthResult } from '../types/auth.js';

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
   * When `context` is provided and the agent has security requirements,
   * authentication is evaluated before routing. When omitted, no auth
   * check is performed (backward compatible).
   *
   * The caller inspects the return value:
   * ```ts
   * const result = await handler.handle(body, { headers: req.headers });
   * if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
   *   // stream → convert to SSE Response
   * } else {
   *   // sync → return as JSON
   * }
   * ```
   */
  async handle(
    body: JSONRPCRequest | string | unknown,
    context?: RequestContext,
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

    // Authenticate if context is provided and security requirements exist
    if (context && this.a2xAgent.securityRequirements.length > 0) {
      const authResult = await this._authenticate(context);
      if (!authResult.authenticated) {
        const error = new AuthenticationRequiredError(
          authResult.error ?? 'Authentication required',
        );
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: error.toJSONRPCError(),
        };
      }
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

  // ─── Private: Authentication ───

  /**
   * Evaluate security requirements using OR-of-ANDs model (OpenAPI standard).
   *
   * Each SecurityRequirement in the array is an AND group:
   *   { apiKey: [], oauth2: ["read"] } → apiKey AND oauth2(read) must pass
   *
   * Multiple requirements form an OR:
   *   [{ apiKey: [] }, { oauth2: ["read"] }] → apiKey OR oauth2(read)
   *
   * Passes if ANY requirement group is fully satisfied.
   */
  private async _authenticate(context: RequestContext): Promise<AuthResult> {
    const requirements = this.a2xAgent.securityRequirements;
    const schemes = this.a2xAgent.securitySchemes;

    const errors: string[] = [];

    for (const requirement of requirements) {
      const schemeNames = Object.keys(requirement);
      let groupPassed = true;
      let groupPrincipal: unknown = undefined;
      let groupScopes: string[] = [];

      for (const schemeName of schemeNames) {
        const scheme = schemes.get(schemeName);
        if (!scheme) {
          groupPassed = false;
          errors.push(`Unknown security scheme: ${schemeName}`);
          break;
        }

        const requiredScopes = requirement[schemeName];

        // Call authenticate — pass requiredScopes for OAuth2 schemes
        let result: AuthResult;
        if ('authenticate' in scheme && typeof scheme.authenticate === 'function') {
          if (scheme.authenticate.length >= 2) {
            // OAuth2-style: authenticate(context, requiredScopes)
            result = await (scheme as { authenticate: (ctx: RequestContext, scopes: string[]) => Promise<AuthResult> })
              .authenticate(context, requiredScopes);
          } else {
            result = await scheme.authenticate(context);
          }
        } else {
          result = { authenticated: true };
        }

        if (!result.authenticated) {
          groupPassed = false;
          errors.push(result.error ?? `${schemeName}: authentication failed`);
          break;
        }

        // Accumulate principal and scopes from successful auth
        if (result.principal !== undefined) {
          groupPrincipal = result.principal;
        }
        if (result.scopes) {
          groupScopes = [...groupScopes, ...result.scopes];
        }

        // Verify required scopes are present (if scopes were returned)
        if (requiredScopes.length > 0 && result.scopes) {
          const missingScopes = requiredScopes.filter(
            (s) => !result.scopes!.includes(s),
          );
          if (missingScopes.length > 0) {
            groupPassed = false;
            errors.push(
              `${schemeName}: missing required scopes: ${missingScopes.join(', ')}`,
            );
            break;
          }
        }
      }

      // If all schemes in this requirement group passed → authenticated
      if (groupPassed) {
        return {
          authenticated: true,
          principal: groupPrincipal,
          scopes: groupScopes.length > 0 ? groupScopes : undefined,
        };
      }
    }

    // No requirement group was satisfied
    return {
      authenticated: false,
      error: errors.join('; '),
    };
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

    // tasks/pushNotificationConfig/delete
    this.router.registerMethod(
      A2A_METHODS.DELETE_PUSH_CONFIG,
      async (params) => {
        const deleteParams = this._validateDeletePushNotificationConfigParams(params);
        return this._handleDeletePushNotificationConfig(deleteParams);
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

    return this.responseMapper.mapTask(canceledTask);
  }

  private async _handleDeletePushNotificationConfig(
    params: DeletePushNotificationConfigParams,
  ): Promise<null> {
    const store = this.a2xAgent.pushNotificationConfigStore;
    if (!store) {
      throw new PushNotificationNotSupportedError();
    }

    const deleted = await store.delete(params.taskId, params.configId);
    if (!deleted) {
      throw new TaskNotFoundError(
        `Push notification config '${params.configId}' not found for task '${params.taskId}'`,
      );
    }

    return null;
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

  /**
   * Validate and normalize delete push notification config params.
   *
   * v0.3 wire format: { id: taskId, pushNotificationConfigId: configId }
   * v1.0 wire format: { taskId: taskId, id: configId }
   *
   * Both are normalized into { taskId, configId }.
   */
  private _validateDeletePushNotificationConfigParams(
    params: unknown,
  ): DeletePushNotificationConfigParams {
    if (!params || typeof params !== 'object') {
      throw new InvalidParamsError(
        'DeletePushNotificationConfig requires task ID and config ID parameters',
      );
    }

    const p = params as Record<string, unknown>;
    let taskId: string;
    let configId: string;

    if (this.a2xAgent.protocolVersion === '0.3') {
      // v0.3: { id: taskId, pushNotificationConfigId: configId }
      if (typeof p.id !== 'string' || p.id.trim() === '') {
        throw new InvalidParamsError(
          'DeletePushNotificationConfig: "id" (task ID) must be a non-empty string',
        );
      }
      if (
        typeof p.pushNotificationConfigId !== 'string' ||
        (p.pushNotificationConfigId as string).trim() === ''
      ) {
        throw new InvalidParamsError(
          'DeletePushNotificationConfig: "pushNotificationConfigId" must be a non-empty string',
        );
      }
      taskId = p.id as string;
      configId = p.pushNotificationConfigId as string;
    } else {
      // v1.0: { taskId: taskId, id: configId }
      if (typeof p.taskId !== 'string' || (p.taskId as string).trim() === '') {
        throw new InvalidParamsError(
          'DeletePushNotificationConfig: "taskId" must be a non-empty string',
        );
      }
      if (typeof p.id !== 'string' || p.id.trim() === '') {
        throw new InvalidParamsError(
          'DeletePushNotificationConfig: "id" (config ID) must be a non-empty string',
        );
      }
      taskId = p.taskId as string;
      configId = p.id as string;
    }

    return {
      taskId,
      configId,
      metadata: p.metadata as Record<string, unknown> | undefined,
    };
  }
}
