/**
 * Layer 4: DefaultRequestHandler - framework-agnostic JSON-RPC handler.
 *
 * Unified `handle()` entry point: returns a `JSONRPCResponse` for sync
 * methods or an `AsyncGenerator` for streaming methods.  The caller
 * (Next.js route, Express middleware, etc.) checks `Symbol.asyncIterator`
 * on the result to decide between a JSON response and an SSE stream.
 */

import { randomUUID } from 'node:crypto';
import type { A2XAgent } from '../a2x/a2x-agent.js';
import type {
  JSONRPCRequest,
  JSONRPCResponse,
  SendMessageParams,
  TaskIdParams,
  DeletePushNotificationConfigParams,
  GetPushNotificationConfigParams,
  ListPushNotificationConfigsParams,
  PushNotificationConfig,
  TaskPushNotificationConfig,
} from '../types/jsonrpc.js';
import { A2A_METHODS } from '../types/jsonrpc.js';
import type { AgentCardV03, AgentCardV10 } from '../types/agent-card.js';
import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types/task.js';
import { TERMINAL_STATES } from '../types/task.js';
import {
  AuthenticatedExtendedCardNotConfiguredError,
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

/**
 * Return type of `handle()`.
 * @deprecated Use {@link HandleHttpResult} instead — it wraps the response
 * body and carries optional HTTP metadata (status, headers).
 */
export type HandleResult =
  | JSONRPCResponse
  | AsyncGenerator<unknown>;

/** HTTP metadata attached to responses that require a non-200 status. */
export interface HttpResponseMeta {
  status: number;
  headers?: Record<string, string>;
}

/** Extended result from handle() that carries optional HTTP metadata. */
export interface HandleHttpResult {
  body: JSONRPCResponse | AsyncGenerator<unknown>;
  http?: HttpResponseMeta;
}

/** Extract the HTTP status code from a HandleHttpResult (defaults to 200). */
export function getHttpStatus(result: HandleHttpResult): number {
  return result.http?.status ?? 200;
}

/** Extract optional HTTP headers from a HandleHttpResult. */
export function getHttpHeaders(result: HandleHttpResult): Record<string, string> {
  return result.http?.headers ?? {};
}

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
   * Returns a `HandleHttpResult` whose `.body` is either a
   * `JSONRPCResponse` (sync methods) or an `AsyncGenerator` (streaming).
   * The optional `.http` field carries status/headers for non-200 cases
   * (e.g. 401 for authentication failures).
   *
   * When `context` is provided and the agent has security requirements,
   * authentication is evaluated before routing. When omitted, no auth
   * check is performed (backward compatible).
   *
   * The caller inspects the return value:
   * ```ts
   * const result = await handler.handle(body, { headers: req.headers });
   * if (result.body && typeof result.body === 'object' && Symbol.asyncIterator in result.body) {
   *   // stream → convert to SSE Response
   * } else {
   *   // sync → return as JSON using getHttpStatus(result) / getHttpHeaders(result)
   * }
   * ```
   */
  async handle(
    body: JSONRPCRequest | string | unknown,
    context?: RequestContext,
  ): Promise<HandleHttpResult> {
    let request: JSONRPCRequest;

    // Parse if string
    if (typeof body === 'string') {
      try {
        request = JSON.parse(body) as JSONRPCRequest;
      } catch {
        const error = new JSONParseError();
        return {
          body: {
            jsonrpc: '2.0',
            id: null,
            error: error.toJSONRPCError(),
          },
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
        body: {
          jsonrpc: '2.0',
          id: request?.id ?? null,
          error: error.toJSONRPCError(),
        },
      };
    }

    // Authenticate if context is provided and security requirements exist.
    // Capture authResult so special-case handlers (e.g. the authenticated
    // extended card) can consume the resolved principal/scopes.
    let authResult: AuthResult | undefined;
    if (context && this.a2xAgent.securityRequirements.length > 0) {
      authResult = await this._authenticate(context);
      if (!authResult.authenticated) {
        const error = new AuthenticationRequiredError(
          authResult.error ?? 'Authentication required',
        );
        return {
          body: {
            jsonrpc: '2.0',
            id: request.id,
            error: error.toJSONRPCError(),
          },
          http: { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } },
        };
      }
    }

    // Special-case: authenticated extended card needs authResult; do not
    // route via JsonRpcRouter because that layer has no access to auth.
    if (request.method === A2A_METHODS.GET_EXTENDED_CARD) {
      try {
        if (!this.a2xAgent.hasAuthenticatedExtendedCardProvider) {
          throw new AuthenticatedExtendedCardNotConfiguredError();
        }
        if (!authResult || !authResult.authenticated) {
          throw new AuthenticationRequiredError(
            'Authentication is required for the authenticated extended card',
          );
        }
        const card = await this.a2xAgent.getAuthenticatedExtendedCard(authResult);
        return {
          body: {
            jsonrpc: '2.0',
            id: request.id,
            result: card,
          },
        };
      } catch (err) {
        return this._toErrorResponse(request.id, err);
      }
    }

    // Streaming method → return AsyncGenerator
    if (this.router.isStreamMethod(request.method)) {
      try {
        return { body: this.router.routeStream(request) as AsyncGenerator<unknown> };
      } catch (err) {
        return this._toErrorResponse(request.id, err);
      }
    }

    // Synchronous method → return JSONRPCResponse
    try {
      return { body: await this.router.route(request) as JSONRPCResponse };
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

    // tasks/resubscribe (SSE)
    this.router.registerStreamMethod(
      A2A_METHODS.RESUBSCRIBE,
      (params) => {
        const taskParams = this._validateTaskIdParams(params);
        return this._handleResubscribe(taskParams);
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

    // tasks/pushNotificationConfig/set
    this.router.registerMethod(
      A2A_METHODS.SET_PUSH_CONFIG,
      async (params) => {
        const setParams = this._validateSetPushNotificationConfigParams(params);
        return this._handleSetPushNotificationConfig(setParams);
      },
    );

    // tasks/pushNotificationConfig/get
    this.router.registerMethod(
      A2A_METHODS.GET_PUSH_CONFIG,
      async (params) => {
        const getParams = this._validateGetPushNotificationConfigParams(params);
        return this._handleGetPushNotificationConfig(getParams);
      },
    );

    // tasks/pushNotificationConfig/list
    this.router.registerMethod(
      A2A_METHODS.LIST_PUSH_CONFIGS,
      async (params) => {
        const listParams = this._validateListPushNotificationConfigParams(params);
        return this._handleListPushNotificationConfigs(listParams);
      },
    );
  }

  // ─── Private: Task Resolution ───

  /**
   * Resolve the `Task` an incoming `message/send` or `message/stream`
   * should execute against.
   *
   * Per A2A spec, a client can continue an existing conversation by
   * setting `message.taskId`. When that points at a live task (not in a
   * terminal state) we reuse it so mid-task state (e.g. the x402
   * extension's `payment-required` → `payment-submitted` hand-off) is
   * preserved; otherwise we create a fresh task.
   */
  private async _resolveTaskForMessage(params: SendMessageParams) {
    const messageTaskId = (params.message as { taskId?: unknown }).taskId;
    if (typeof messageTaskId === 'string' && messageTaskId.length > 0) {
      const existing = await this.a2xAgent.taskStore.getTask(messageTaskId);
      if (existing && !TERMINAL_STATES.has(existing.status.state)) {
        return existing;
      }
    }
    return this.a2xAgent.taskStore.createTask({
      contextId: params.message.contextId,
      metadata: params.metadata,
    });
  }

  // ─── Private: Method Handlers ───

  private async _handleSendMessage(params: SendMessageParams): Promise<unknown> {
    const task = await this._resolveTaskForMessage(params);

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

    const task = await this._resolveTaskForMessage(params);

    const eventStream = this.a2xAgent.agentExecutor.executeStream(
      task,
      params.message,
    );

    const bus = this.a2xAgent.taskEventBus;

    // finally closes the bus so resubscribers see the stream end regardless
    // of how the primary stream terminates (normal, error, cancel via return).
    try {
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
        bus.publish(task.id, event);
        if ('status' in event) {
          yield this.responseMapper.mapStatusUpdateEvent(event as TaskStatusUpdateEvent);
        } else {
          yield this.responseMapper.mapArtifactUpdateEvent(event as TaskArtifactUpdateEvent);
        }
      }
    } finally {
      bus.close(task.id);
    }
  }

  private async *_handleResubscribe(
    params: TaskIdParams,
  ): AsyncGenerator<unknown> {
    const task = await this.a2xAgent.taskStore.getTask(params.id);
    if (!task) {
      throw new TaskNotFoundError(`Task not found: ${params.id}`);
    }

    // Terminal tasks replay a single status-update event so reconnecting
    // clients learn the final state without needing a full history replay.
    if (TERMINAL_STATES.has(task.status.state)) {
      const terminal: TaskStatusUpdateEvent = {
        taskId: task.id,
        contextId: task.contextId ?? task.id,
        status: task.status,
      };
      yield this.responseMapper.mapStatusUpdateEvent(terminal);
      return;
    }

    const bus = this.a2xAgent.taskEventBus;
    for await (const event of bus.subscribe(params.id)) {
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

  private async _handleSetPushNotificationConfig(
    params: TaskPushNotificationConfig,
  ): Promise<unknown> {
    const store = this.a2xAgent.pushNotificationConfigStore;
    if (!store) {
      throw new PushNotificationNotSupportedError();
    }

    const saved = await store.set(params);
    return this.responseMapper.mapPushNotificationConfig(saved);
  }

  private async _handleGetPushNotificationConfig(
    params: GetPushNotificationConfigParams,
  ): Promise<unknown> {
    const store = this.a2xAgent.pushNotificationConfigStore;
    if (!store) {
      throw new PushNotificationNotSupportedError();
    }

    let config: TaskPushNotificationConfig | null = null;
    if (params.configId) {
      config = await store.get(params.taskId, params.configId);
      if (!config) {
        throw new TaskNotFoundError(
          `Push notification config '${params.configId}' not found for task '${params.taskId}'`,
        );
      }
    } else {
      // v0.3 spec allows { id: taskId } without pushNotificationConfigId; fall
      // back to the first stored config for the task.
      const all = await store.list(params.taskId);
      if (all.length === 0) {
        throw new TaskNotFoundError(
          `No push notification configs found for task '${params.taskId}'`,
        );
      }
      config = all[0]!;
    }

    return this.responseMapper.mapPushNotificationConfig(config);
  }

  private async _handleListPushNotificationConfigs(
    params: ListPushNotificationConfigsParams,
  ): Promise<unknown> {
    const store = this.a2xAgent.pushNotificationConfigStore;
    if (!store) {
      throw new PushNotificationNotSupportedError();
    }

    const configs = await store.list(params.taskId);
    return this.responseMapper.mapPushNotificationConfigList(configs);
  }

  // ─── Private: Helpers ───

  private _toErrorResponse(
    id: string | number | null,
    err: unknown,
  ): HandleHttpResult {
    if (err && typeof err === 'object' && 'toJSONRPCError' in err) {
      const isAuthError = err instanceof AuthenticationRequiredError;
      return {
        body: {
          jsonrpc: '2.0',
          id,
          error: (err as A2AError).toJSONRPCError(),
        },
        ...(isAuthError ? { http: { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } } } : {}),
      };
    }
    const internalError = new InternalError(
      err instanceof Error ? err.message : 'Internal error',
    );
    return {
      body: {
        jsonrpc: '2.0',
        id,
        error: internalError.toJSONRPCError(),
      },
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

  /**
   * Validate set push notification config params.
   *
   * Per v0.3 spec `SetTaskPushNotificationConfigRequest.params` is a
   * `TaskPushNotificationConfig` with shape `{ taskId, pushNotificationConfig }`
   * (no top-level `id`). `pushNotificationConfig.id` is optional per spec; the
   * server assigns a UUID when the client omits it so the store can key it.
   * v1.0 does not define a Set method; the SDK exposes the same JSON-RPC
   * method name for both protocol versions as an extension and accepts the
   * same nested shape.
   */
  private _validateSetPushNotificationConfigParams(
    params: unknown,
  ): TaskPushNotificationConfig {
    if (!params || typeof params !== 'object') {
      throw new InvalidParamsError(
        'SetPushNotificationConfig requires a "taskId" and "pushNotificationConfig" parameter',
      );
    }

    const p = params as Record<string, unknown>;

    if (typeof p.taskId !== 'string' || (p.taskId as string).trim() === '') {
      throw new InvalidParamsError(
        'SetPushNotificationConfig: "taskId" must be a non-empty string',
      );
    }

    const nested = p.pushNotificationConfig;
    if (!nested || typeof nested !== 'object') {
      throw new InvalidParamsError(
        'SetPushNotificationConfig: "pushNotificationConfig" must be an object',
      );
    }

    const n = nested as Record<string, unknown>;
    if (typeof n.url !== 'string' || (n.url as string).trim() === '') {
      throw new InvalidParamsError(
        'SetPushNotificationConfig: "pushNotificationConfig.url" must be a non-empty string',
      );
    }
    if (n.id !== undefined && typeof n.id !== 'string') {
      throw new InvalidParamsError(
        'SetPushNotificationConfig: "pushNotificationConfig.id" must be a string when provided',
      );
    }
    if (n.token !== undefined && typeof n.token !== 'string') {
      throw new InvalidParamsError(
        'SetPushNotificationConfig: "pushNotificationConfig.token" must be a string when provided',
      );
    }
    if (n.authentication !== undefined) {
      if (n.authentication === null || typeof n.authentication !== 'object') {
        throw new InvalidParamsError(
          'SetPushNotificationConfig: "pushNotificationConfig.authentication" must be an object when provided',
        );
      }
      const auth = n.authentication as Record<string, unknown>;
      if (!Array.isArray(auth.schemes) || auth.schemes.length === 0) {
        throw new InvalidParamsError(
          'SetPushNotificationConfig: "pushNotificationConfig.authentication.schemes" must be a non-empty array of strings',
        );
      }
      for (const scheme of auth.schemes) {
        if (typeof scheme !== 'string' || scheme.trim() === '') {
          throw new InvalidParamsError(
            'SetPushNotificationConfig: "pushNotificationConfig.authentication.schemes" entries must be non-empty strings',
          );
        }
      }
      if (auth.credentials !== undefined && typeof auth.credentials !== 'string') {
        throw new InvalidParamsError(
          'SetPushNotificationConfig: "pushNotificationConfig.authentication.credentials" must be a string when provided',
        );
      }
    }

    // Empty-string id is treated as absent (v1.0 proto-default semantic);
    // the server assigns a UUID so the store can key the entry.
    const clientId = typeof n.id === 'string' && n.id.length > 0 ? n.id : undefined;
    const innerConfig: PushNotificationConfig = {
      id: clientId ?? randomUUID(),
      url: n.url,
      ...(n.token !== undefined ? { token: n.token as string } : {}),
      ...(n.authentication !== undefined
        ? { authentication: n.authentication as PushNotificationConfig['authentication'] }
        : {}),
    };

    return {
      taskId: p.taskId,
      pushNotificationConfig: innerConfig,
    };
  }

  /**
   * Validate and normalize get push notification config params.
   *
   * v0.3 wire: anyOf(TaskIdParams, GetTaskPushNotificationConfigParams)
   *   - TaskIdParams: { id: taskId }  → configId undefined (handler returns
   *     the first config for that task).
   *   - Get...Params: { id: taskId, pushNotificationConfigId?: configId }
   * v1.0 wire: { taskId, id: configId }
   *
   * Both are normalized into { taskId, configId? } so the handler can
   * branch on whether a specific config was requested.
   */
  private _validateGetPushNotificationConfigParams(
    params: unknown,
  ): GetPushNotificationConfigParams {
    if (!params || typeof params !== 'object') {
      throw new InvalidParamsError(
        'GetPushNotificationConfig requires a task ID parameter',
      );
    }

    const p = params as Record<string, unknown>;
    let taskId: string;
    let configId: string | undefined;

    if (this.a2xAgent.protocolVersion === '0.3') {
      // v0.3: { id: taskId, pushNotificationConfigId?: configId }
      if (typeof p.id !== 'string' || p.id.trim() === '') {
        throw new InvalidParamsError(
          'GetPushNotificationConfig: "id" (task ID) must be a non-empty string',
        );
      }
      taskId = p.id as string;
      if (p.pushNotificationConfigId !== undefined) {
        if (
          typeof p.pushNotificationConfigId !== 'string' ||
          (p.pushNotificationConfigId as string).trim() === ''
        ) {
          throw new InvalidParamsError(
            'GetPushNotificationConfig: "pushNotificationConfigId" must be a non-empty string when provided',
          );
        }
        configId = p.pushNotificationConfigId as string;
      }
    } else {
      // v1.0: { taskId: taskId, id: configId }
      if (typeof p.taskId !== 'string' || (p.taskId as string).trim() === '') {
        throw new InvalidParamsError(
          'GetPushNotificationConfig: "taskId" must be a non-empty string',
        );
      }
      if (typeof p.id !== 'string' || p.id.trim() === '') {
        throw new InvalidParamsError(
          'GetPushNotificationConfig: "id" (config ID) must be a non-empty string',
        );
      }
      taskId = p.taskId as string;
      configId = p.id as string;
    }

    return {
      taskId,
      ...(configId !== undefined ? { configId } : {}),
      metadata: p.metadata as Record<string, unknown> | undefined,
    };
  }

  /**
   * Validate and normalize list push notification configs params.
   *
   * v0.3 wire format: { id: taskId }
   * v1.0 wire format: { taskId, pageSize?, pageToken? }
   *
   * Pagination fields (pageSize/pageToken) are accepted but ignored.
   */
  private _validateListPushNotificationConfigParams(
    params: unknown,
  ): ListPushNotificationConfigsParams {
    if (!params || typeof params !== 'object') {
      throw new InvalidParamsError(
        'ListPushNotificationConfig requires a task ID parameter',
      );
    }

    const p = params as Record<string, unknown>;
    let taskId: string;

    if (this.a2xAgent.protocolVersion === '0.3') {
      // v0.3: { id: taskId }
      if (typeof p.id !== 'string' || p.id.trim() === '') {
        throw new InvalidParamsError(
          'ListPushNotificationConfig: "id" (task ID) must be a non-empty string',
        );
      }
      taskId = p.id as string;
    } else {
      // v1.0: { taskId: taskId, pageSize?, pageToken? }
      if (typeof p.taskId !== 'string' || (p.taskId as string).trim() === '') {
        throw new InvalidParamsError(
          'ListPushNotificationConfig: "taskId" must be a non-empty string',
        );
      }
      taskId = p.taskId as string;
    }

    return {
      taskId,
      metadata: p.metadata as Record<string, unknown> | undefined,
    };
  }
}
