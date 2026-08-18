/**
 * Layer 4: DefaultRequestHandler - framework-agnostic JSON-RPC handler.
 *
 * Unified `handle()` entry point: returns a `JSONRPCResponse` for sync
 * methods or an `AsyncGenerator` for streaming methods.  The caller
 * (Next.js route, Express middleware, etc.) checks `Symbol.asyncIterator`
 * on the result to decide between a JSON response and an SSE stream.
 */

import { randomUUID } from 'node:crypto';
import type { A2XServer } from '../a2x/a2x-agent.js';
import type {
  JSONRPCRequest,
  JSONRPCResponse,
  SendMessageParams,
  TaskIdParams,
  TaskQueryParams,
  DeletePushNotificationConfigParams,
  GetPushNotificationConfigParams,
  ListPushNotificationConfigsParams,
  PushNotificationAuthenticationInfo,
  PushNotificationConfig,
  TaskPushNotificationConfig,
} from '../types/jsonrpc.js';
import { A2A_METHODS, A2A_METHODS_V10 } from '../types/jsonrpc.js';
import type { AgentCardV03, AgentCardV10 } from '../types/agent-card.js';
import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types/task.js';
import { TERMINAL_STATES } from '../types/task.js';
import {
  AuthenticatedExtendedCardNotConfiguredError,
  InternalError,
  InvalidParamsError,
  InvalidRequestError,
  JSONParseError,
  PushNotificationNotSupportedError,
  TaskNotCancelableError,
  TaskNotFoundError,
  UnsupportedOperationError,
  VersionNotSupportedError,
  type A2AError,
} from '../types/errors.js';
import type { Artifact } from '../types/common.js';
import { V10_ROLE_TO_INTERNAL } from '../types/common.js';
import { StreamingMode } from '../a2x/agent-executor.js';
import { applyArtifactUpdate, type TaskUpdate } from '../a2x/task-store.js';
import { JsonRpcRouter, type RouteContext } from './jsonrpc-router.js';
import { isX402ExtensionUri } from '../x402/constants.js';
import type { ResponseMapper } from '../a2x/response-mapper.js';
import { ResponseMapperFactory } from '../a2x/response-mapper.js';
import type { RequestContext, AuthResult } from '../types/auth.js';
import type { Task } from '../types/task.js';
import { TaskState } from '../types/task.js';

/** Return type of `handle()`. */
export type HandleResult =
  | JSONRPCResponse
  | AsyncGenerator<unknown>;

/**
 * v1.0 method name → canonical (v0.3) method name used by the dispatch
 * table. Internal to the handler — the public constants are the two
 * method tables themselves (`A2A_METHODS`, `A2A_METHODS_V10`).
 */
const V10_METHOD_TO_CANONICAL: ReadonlyMap<string, string> = new Map(
  (Object.keys(A2A_METHODS_V10) as (keyof typeof A2A_METHODS_V10)[]).map(
    (key) => [A2A_METHODS_V10[key], A2A_METHODS[key]],
  ),
);

export class DefaultRequestHandler {
  private readonly a2xServer: A2XServer;
  private readonly router: JsonRpcRouter;
  private readonly responseMapper: ResponseMapper;

  constructor(a2xServer: A2XServer) {
    this.a2xServer = a2xServer;
    this.router = new JsonRpcRouter();
    this.responseMapper = ResponseMapperFactory.getMapper(a2xServer.protocolVersion);
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

    // Spec a2a-v1.0 §3.2.6 / §9.2: a client may pin the protocol version
    // via the `A2A-Version` header. One A2XServer speaks exactly one
    // version, so a mismatching pin gets `VersionNotSupportedError`
    // (-32009) instead of a silently mis-encoded payload. An absent
    // header keeps serving the configured version — the spec's
    // "assume 0.3 when empty" rule presumes per-request encoding, which
    // this server deliberately does not do.
    if (context) {
      const requested = readA2AVersionHeader(context.headers);
      if (
        requested !== undefined &&
        toMajorMinor(requested) !== this.a2xServer.protocolVersion
      ) {
        const error = new VersionNotSupportedError(
          `A2A protocol version '${requested}' is not supported; this endpoint serves '${this.a2xServer.protocolVersion}'`,
        );
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: error.toJSONRPCError(),
        };
      }
    }

    // Spec a2a-v1.0 §9.4 renames every JSON-RPC method (`SendMessage`,
    // `GetTask`, …). Normalize v1.0 spellings to the canonical v0.3
    // dispatch names up front so auth special-casing and routing below
    // see a single method vocabulary. v0.3 spellings stay accepted on a
    // v1.0 server as a legacy-compat extension; a v0.3 server remains
    // strictly v0.3 and rejects v1.0 spellings with -32601.
    if (this.a2xServer.protocolVersion === '1.0') {
      const canonical = V10_METHOD_TO_CANONICAL.get(request.method);
      if (canonical !== undefined) {
        request = { ...request, method: canonical };
      }
    }

    // Authenticate if context is provided and security requirements exist.
    // Capture authResult so special-case handlers (e.g. the authenticated
    // extended card) can consume the resolved principal/scopes.
    //
    // Spec a2a-v0.3 / v1.0 model auth failure as a Task lifecycle state
    // (`TaskState.AUTH_REQUIRED`), not as a JSON-RPC error. For methods
    // whose response shape is a Task (`message/send`, `message/stream`),
    // emit an auth-required task. Other methods don't have a task-shaped
    // response, so they fall back to `-32600 InvalidRequest`.
    let authResult: AuthResult | undefined;
    if (context && this.a2xServer.securityRequirements.length > 0) {
      authResult = await this._authenticate(context);
      if (!authResult.authenticated) {
        const reason = authResult.error ?? 'Authentication required';
        if (request.method === A2A_METHODS.SEND_MESSAGE) {
          return this._buildAuthRequiredResponse(request, reason);
        }
        if (request.method === A2A_METHODS.STREAM_MESSAGE) {
          return this._wrapStreamInJsonRpc(
            request.id,
            this._buildAuthRequiredStream(request, reason),
          );
        }
        const error = new InvalidRequestError(reason);
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: error.toJSONRPCError(),
        };
      }
    }

    // Enforce `required: true` extension activation per spec a2a-x402 v0.2
    // §3.1 / §8. Clients must list the extension URI in the
    // `X-A2A-Extensions` (v0.3) / `A2A-Extensions` (v1.0) header;
    // unactivated clients get a -32600
    // InvalidRequest. Skipped when no request context is provided
    // (in-process / test invocations without HTTP framing).
    if (context) {
      const activationError = this._validateExtensionActivation(context);
      if (activationError) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: activationError.toJSONRPCError(),
        };
      }
    }

    // Special-case: authenticated extended card needs authResult; do not
    // route via JsonRpcRouter because that layer has no access to auth.
    if (request.method === A2A_METHODS.GET_EXTENDED_CARD) {
      try {
        if (!this.a2xServer.hasAuthenticatedExtendedCardProvider) {
          throw new AuthenticatedExtendedCardNotConfiguredError();
        }
        if (!authResult || !authResult.authenticated) {
          throw new InvalidRequestError(
            'Authentication is required for the authenticated extended card',
          );
        }
        const card = await this.a2xServer.getAuthenticatedExtendedCard(authResult);
        return {
          jsonrpc: '2.0',
          id: request.id,
          result: card,
        };
      } catch (err) {
        return this._toErrorResponse(request.id, err);
      }
    }

    // Streaming method → return AsyncGenerator. Each chunk is wrapped
    // in a JSON-RPC success envelope keyed by `request.id`, per spec
    // a2a-v0.3 §SendStreamingMessageSuccessResponse — every frame on
    // the stream is a full JSONRPCResponse, not a bare event object.
    const routeContext: RouteContext | undefined = context
      ? { activatedExtensions: [...parseActivatedExtensions(context.headers)] }
      : undefined;

    if (this.router.isStreamMethod(request.method)) {
      try {
        const inner = this.router.routeStream(
          request,
          routeContext,
        ) as AsyncGenerator<unknown>;
        return this._wrapStreamInJsonRpc(request.id, inner);
      } catch (err) {
        return this._toErrorResponse(request.id, err);
      }
    }

    // Synchronous method → return JSONRPCResponse
    try {
      return await this.router.route(request, routeContext);
    } catch (err) {
      return this._toErrorResponse(request.id, err);
    }
  }

  /**
   * Get the AgentCard. Always rendered in the agent's configured
   * `protocolVersion` to match the wire format the server actually speaks.
   */
  getAgentCard(): AgentCardV03 | AgentCardV10 {
    return this.a2xServer.getAgentCard();
  }

  // ─── Private: auth-required Task synthesis ───

  /**
   * Build an ephemeral Task in `auth-required` state for a single
   * `message/send` request that failed authentication. Per A2A spec
   * (`TaskState.auth-required` in v0.3 / `TASK_STATE_AUTH_REQUIRED` in
   * v1.0), this is the protocol-level signal that prompts the client to
   * acquire credentials and retry. The task is NOT persisted to the
   * store — unauthenticated callers must not be able to allocate task
   * IDs at will.
   */
  private _buildAuthRequiredResponse(
    request: JSONRPCRequest,
    reason: string,
  ): JSONRPCResponse {
    const userMessage = (request.params as { message?: unknown } | undefined)
      ?.message;
    const task = this._buildAuthRequiredTask(request, reason);
    return {
      jsonrpc: '2.0',
      id: request.id,
      result: this.responseMapper.mapTask(
        task,
        userMessage as Parameters<ResponseMapper['mapTask']>[1],
      ),
    };
  }

  /**
   * Streaming counterpart to `_buildAuthRequiredResponse`. Emits a single
   * `TaskStatusUpdateEvent` carrying `auth-required` and closes — clients
   * react to the state and refresh their credentials before retrying via
   * a fresh `message/stream`.
   */
  private async *_buildAuthRequiredStream(
    request: JSONRPCRequest,
    reason: string,
  ): AsyncGenerator<unknown> {
    const task = this._buildAuthRequiredTask(request, reason);
    yield this.responseMapper.mapStatusUpdateEvent({
      taskId: task.id,
      contextId: task.contextId ?? '',
      status: task.status,
      // Spec a2a-v0.3 §TaskStatusUpdateEvent: `final: true` marks the last
      // event for the stream. v1.0 dropped the field — the mapper handles
      // both cases.
      final: true,
    });
  }

  private _buildAuthRequiredTask(
    request: JSONRPCRequest,
    reason: string,
  ): Task {
    const params = request.params as
      | { message?: { contextId?: string } }
      | undefined;
    return {
      id: randomUUID(),
      contextId: params?.message?.contextId ?? randomUUID(),
      status: {
        state: TaskState.AUTH_REQUIRED,
        message: {
          messageId: randomUUID(),
          role: 'agent',
          parts: [{ text: reason }],
        },
        timestamp: new Date().toISOString(),
      },
    };
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
    const requirements = this.a2xServer.securityRequirements;
    const schemes = this.a2xServer.securitySchemes;

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

  /**
   * Parse the extension activation header (`X-A2A-Extensions` /
   * `A2A-Extensions`, comma-separated list) and validate that every
   * `required: true` extension declared on the AgentCard is present.
   * Returns an `InvalidRequestError` when any required extension is
   * missing, `null` on success.
   *
   * Spec a2a-x402 v0.2 §3.1 / §8: clients MUST list activated extension
   * URIs, and agents should reject requests that omit a required one.
   */
  private _validateExtensionActivation(
    context: RequestContext,
  ): InvalidRequestError | null {
    const required = this.a2xServer.extensions.filter((ext) => ext.required);
    if (required.length === 0) return null;

    const activated = parseActivatedExtensions(context.headers);
    // The x402 extension URIs form an activation family: activating any
    // member satisfies a required family URI, so a legacy client that only
    // knows the v0.2 URI still passes an agent that requires the foundation
    // URI. Version compatibility is not checked here — the transport
    // layer doesn't know which version the deployment speaks; a V2
    // server refuses a v0.2 (V1-only) activation in
    // `BaseX402Context.requestPayment`.
    const anyX402Activated = [...activated].some((uri) =>
      isX402ExtensionUri(uri),
    );
    const missing = required
      .map((ext) => ext.uri)
      .filter((uri) => {
        if (activated.has(uri)) return false;
        if (isX402ExtensionUri(uri) && anyX402Activated) return false;
        return true;
      });

    if (missing.length === 0) return null;
    const headerName =
      this.a2xServer.protocolVersion === '1.0'
        ? 'A2A-Extensions'
        : 'X-A2A-Extensions';
    return new InvalidRequestError(
      `Required A2A extensions not activated. Include these URIs in the ${headerName} header: ${missing.join(', ')}`,
    );
  }

  // ─── Private: Route Registration ───

  private _registerRoutes(): void {
    // message/send
    this.router.registerMethod(
      A2A_METHODS.SEND_MESSAGE,
      async (params, _request, context) => {
        const sendParams = this._validateSendMessageParams(params);
        return this._handleSendMessage(sendParams, context);
      },
    );

    // message/stream (SSE)
    this.router.registerStreamMethod(
      A2A_METHODS.STREAM_MESSAGE,
      (params, _request, context) => {
        const sendParams = this._validateSendMessageParams(params);
        return this._handleStreamMessage(sendParams, context);
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

    // tasks/get — uses TaskQueryParams (id + optional historyLength) per
    // spec a2a-v0.3 §GetTaskRequest, not the bare TaskIdParams.
    this.router.registerMethod(
      A2A_METHODS.GET_TASK,
      async (params) => {
        const taskParams = this._validateTaskQueryParams(params);
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
      const existing = await this.a2xServer.taskStore.getTask(messageTaskId);
      if (existing && !TERMINAL_STATES.has(existing.status.state)) {
        return existing;
      }
    }
    return this.a2xServer.taskStore.createTask({
      contextId: params.message.contextId,
      metadata: params.metadata,
    });
  }

  // ─── Private: Method Handlers ───

  private async _handleSendMessage(
    params: SendMessageParams,
    context?: RouteContext,
  ): Promise<unknown> {
    const task = await this._resolveTaskForMessage(params);

    // Spec a2a-v0.3 §MessageSendConfiguration: clients can register a
    // push notification config in the same call that creates the task.
    // Honor it before kicking off execution so the agent's lifecycle
    // events can find the config when delivery is wired.
    await this._registerInlinePushConfig(task.id, params.configuration);

    // The executor marks its own snapshot WORKING; write that first so a
    // concurrent `tasks/get` reports `working` for the duration of a long
    // execution instead of the pre-execution state. `message/stream`
    // persists the same transition as its first event.
    const workingTask = await this._persistTaskState(task.id, {
      status: { state: TaskState.WORKING, timestamp: new Date().toISOString() },
    });

    // Cancellation can win between resolving the task and writing WORKING.
    // `_persistTaskState` returns the terminal store record in that case;
    // executing anyway would run agent side effects for an already-canceled
    // task.
    if (TERMINAL_STATES.has(workingTask.status.state)) {
      return this.responseMapper.mapTask(
        sliceHistory(workingTask, params.configuration?.historyLength),
        params.message,
      );
    }

    // Captured before `execute()`, which overwrites the snapshot's artifacts
    // with only what this turn produced.
    const priorArtifacts = workingTask.artifacts ?? [];

    const executed = await this.a2xServer.agentExecutor.execute(
      workingTask,
      params.message,
      context?.activatedExtensions
        ? { activatedExtensions: context.activatedExtensions }
        : undefined,
    );

    // `execute()` only mutates its Task argument — that object is a
    // snapshot, so the transition has to be written back explicitly or a
    // durable store keeps serving the pre-execution record. The response
    // is mapped from what the store returned so it matches a subsequent
    // `tasks/get` exactly.
    const update = taskUpdateFrom(executed);
    if (executed.artifacts) {
      update.artifacts = mergeArtifacts(priorArtifacts, executed.artifacts);
    }
    const completedTask = await this._persistTaskState(workingTask.id, update);

    const sliced = sliceHistory(
      completedTask,
      params.configuration?.historyLength,
    );

    // Spec a2a-v0.3 §AgentCapabilities.pushNotifications: deliver
    // webhook callbacks for tasks that the client subscribed to. We fire
    // on terminal state (the most common subscription point); embedders
    // that want non-terminal pings can wrap PushNotificationSender.
    if (TERMINAL_STATES.has(completedTask.status.state)) {
      void this._dispatchPushNotifications(completedTask);
    }

    return this.responseMapper.mapTask(sliced, params.message);
  }

  /**
   * Write a task transition through the `TaskStore`.
   *
   * Stores are free to hand out snapshots (`InMemoryTaskStore` does, and
   * any serializing store does by nature), so every transition a handler
   * observes must be persisted explicitly — otherwise the response and a
   * later `tasks/get` disagree.
   *
   * The single tolerated failure is losing a race with `tasks/cancel`:
   * the store then already holds a terminal record, and that record wins
   * over whatever the executor produced afterwards.
   */
  private async _persistTaskState(
    taskId: string,
    update: TaskUpdate,
  ): Promise<Task> {
    try {
      return await this.a2xServer.taskStore.updateTask(taskId, update);
    } catch (error) {
      // The write failure is the root cause — a failing recovery read
      // must not replace it in the error surfaced to the caller.
      let stored: Task | null = null;
      try {
        stored = await this.a2xServer.taskStore.getTask(taskId);
      } catch {
        throw error;
      }
      if (stored && TERMINAL_STATES.has(stored.status.state)) {
        return stored;
      }
      throw error;
    }
  }

  private async _registerInlinePushConfig(
    taskId: string,
    config: SendMessageParams['configuration'],
  ): Promise<void> {
    const pushConfig = config?.pushNotificationConfig;
    if (!pushConfig) return;

    const store = this.a2xServer.pushNotificationConfigStore;
    if (!store) {
      throw new PushNotificationNotSupportedError();
    }

    const id = pushConfig.id ?? randomUUID();
    await store.set({
      taskId,
      pushNotificationConfig: { ...pushConfig, id },
    });
  }

  /**
   * Look up every config registered for the task and hand each off to
   * the configured `PushNotificationSender`. Best-effort and fire-and-
   * forget — a slow or broken webhook must not stall the response path.
   *
   * The webhook body is the spec-mapped Task wire payload (v0.3 `kind`
   * discriminators / v1.0 UPPER_CASE state and role) so receivers see
   * exactly the same shape they would from `tasks/get`. The internal
   * `Task` is only used inside the SDK and must not leak onto the wire.
   */
  private async _dispatchPushNotifications(task: Task): Promise<void> {
    const store = this.a2xServer.pushNotificationConfigStore;
    const sender = this.a2xServer.pushNotificationSender;
    if (!store || !sender) return;
    let configs;
    try {
      configs = await store.list(task.id);
    } catch {
      return;
    }
    const body = this.responseMapper.mapTask(task);
    for (const config of configs) {
      void sender.send(config, body);
    }
  }

  private async *_handleStreamMessage(
    params: SendMessageParams,
    context?: RouteContext,
  ): AsyncGenerator<unknown> {
    if (
      this.a2xServer.agentExecutor.runConfig.streamingMode ===
      StreamingMode.NONE
    ) {
      throw new UnsupportedOperationError(
        'Streaming is not supported by this agent',
      );
    }

    const task = await this._resolveTaskForMessage(params);

    // Register the inline pushNotificationConfig (if any) before kicking
    // off execution, mirroring `_handleSendMessage`. See spec a2a-v0.3
    // §MessageSendConfiguration.
    await this._registerInlinePushConfig(task.id, params.configuration);

    const eventStream = this.a2xServer.agentExecutor.executeStream(
      task,
      params.message,
      context?.activatedExtensions
        ? { activatedExtensions: context.activatedExtensions }
        : undefined,
    );

    const bus = this.a2xServer.taskEventBus;

    let reachedTerminal = false;

    // The executor mutates its own Task snapshot, so the store only learns
    // about the stream through these writes. Artifact chunks are folded
    // into `artifacts` and flushed with the next status write (statuses
    // are rare, text chunks are not) — the terminal write therefore
    // carries the complete artifact set.
    //
    // Seeded from the task's own artifacts: a continuation turn restarts
    // the executor's artifact list, and writes replace rather than merge,
    // so starting empty would drop what an earlier turn already produced.
    const priorArtifacts = task.artifacts ?? [];
    const initialTaskArtifacts = task.artifacts;
    let artifacts: Artifact[] = [...priorArtifacts];
    let unflushedArtifacts = false;

    // finally closes the bus so resubscribers see the stream end regardless
    // of how the primary stream terminates (normal, error, cancel via return).
    try {
      for await (const event of eventStream) {
        if ('status' in event) {
          const terminal = TERMINAL_STATES.has(event.status.state);
          // The default executor writes a canonical current-turn artifact
          // set onto its Task snapshot before an interaction-ending status.
          // Prefer it when present so blocking and streaming persist the
          // same artifact order while still retaining earlier turns.
          if (task.artifacts && task.artifacts !== initialTaskArtifacts) {
            artifacts = mergeArtifacts(priorArtifacts, task.artifacts);
            unflushedArtifacts = true;
          }
          await this._persistTaskState(task.id, {
            status: event.status,
            ...(unflushedArtifacts ? { artifacts } : {}),
          });
          // A terminal event only counts after its store write succeeds.
          // If the write fails, `finally` must still flush artifacts and
          // must not dispatch a non-terminal task as a terminal webhook.
          if (terminal) reachedTerminal = true;
          unflushedArtifacts = false;
        } else {
          artifacts = applyArtifactUpdate(
            artifacts,
            event as TaskArtifactUpdateEvent,
          );
          unflushedArtifacts = true;
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
      // Artifacts emitted after the last status event (abort, client
      // disconnect) still belong in the store. A terminal event already
      // flushed them, and a terminal task's content must not keep
      // changing afterwards. Best-effort: the stream is already
      // unwinding, possibly because of an error we must not mask.
      if (unflushedArtifacts && !reachedTerminal) {
        try {
          await this._persistTaskState(task.id, { artifacts });
        } catch {
          // Nothing left to report the failure on.
        }
      }
      if (reachedTerminal) {
        // Re-fetch the task so the webhook body reflects the final
        // store state (artifacts accumulated during streaming, etc).
        const final = await this.a2xServer.taskStore.getTask(task.id);
        if (final) void this._dispatchPushNotifications(final);
      }
    }
  }

  private async *_handleResubscribe(
    params: TaskIdParams,
  ): AsyncGenerator<unknown> {
    const task = await this.a2xServer.taskStore.getTask(params.id);
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
        final: true,
      };
      yield this.responseMapper.mapStatusUpdateEvent(terminal);
      return;
    }

    const bus = this.a2xServer.taskEventBus;
    for await (const event of bus.subscribe(params.id)) {
      if ('status' in event) {
        yield this.responseMapper.mapStatusUpdateEvent(event as TaskStatusUpdateEvent);
      } else {
        yield this.responseMapper.mapArtifactUpdateEvent(event as TaskArtifactUpdateEvent);
      }
    }
  }

  private async _handleGetTask(params: TaskQueryParams): Promise<unknown> {
    const task = await this.a2xServer.taskStore.getTask(params.id);
    if (!task) {
      throw new TaskNotFoundError(`Task not found: ${params.id}`);
    }
    const sliced = sliceHistory(task, params.historyLength);
    return this.responseMapper.mapTask(sliced);
  }

  private async _handleCancelTask(params: TaskIdParams): Promise<unknown> {
    const task = await this.a2xServer.taskStore.getTask(params.id);
    if (!task) {
      throw new TaskNotFoundError(`Task not found: ${params.id}`);
    }

    if (TERMINAL_STATES.has(task.status.state)) {
      throw new TaskNotCancelableError(
        `Task '${params.id}' is in terminal state '${task.status.state}' and cannot be canceled`,
      );
    }

    const canceled = await this.a2xServer.agentExecutor.cancel(task);
    const persisted = await this._persistTaskState(
      params.id,
      taskUpdateFrom(canceled),
    );

    // The task can reach a different state between the guard above and
    // this write. Compare against what the executor requested rather than
    // requiring CANCELED: custom executors may complete graceful cleanup
    // during cancel, and that successful result must remain representable.
    if (persisted.status.state !== canceled.status.state) {
      throw new TaskNotCancelableError(
        `Task '${params.id}' transitioned to '${persisted.status.state}' while cancellation requested '${canceled.status.state}'`,
      );
    }

    return this.responseMapper.mapTask(persisted);
  }

  private async _handleDeletePushNotificationConfig(
    params: DeletePushNotificationConfigParams,
  ): Promise<null> {
    const store = this.a2xServer.pushNotificationConfigStore;
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
    const store = this.a2xServer.pushNotificationConfigStore;
    if (!store) {
      throw new PushNotificationNotSupportedError();
    }

    const saved = await store.set(params);
    return this.responseMapper.mapPushNotificationConfig(saved);
  }

  private async _handleGetPushNotificationConfig(
    params: GetPushNotificationConfigParams,
  ): Promise<unknown> {
    const store = this.a2xServer.pushNotificationConfigStore;
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
    const store = this.a2xServer.pushNotificationConfigStore;
    if (!store) {
      throw new PushNotificationNotSupportedError();
    }

    const configs = await store.list(params.taskId);
    return this.responseMapper.mapPushNotificationConfigList(configs);
  }

  // ─── Private: Helpers ───

  /**
   * Wrap each chunk of an inner stream generator into a JSON-RPC success
   * envelope (`{ jsonrpc, id, result }`). Mid-stream errors are surfaced
   * as a single trailing JSON-RPC error envelope, then the stream closes
   * — clients keyed on the request id can correlate the failure.
   */
  private async *_wrapStreamInJsonRpc(
    id: string | number | null,
    inner: AsyncGenerator<unknown>,
  ): AsyncGenerator<JSONRPCResponse> {
    try {
      for await (const event of inner) {
        yield { jsonrpc: '2.0', id, result: event };
      }
    } catch (err) {
      yield this._toErrorResponse(id, err);
    }
  }

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

    // Spec a2a-v1.0 §Role: v1.0 clients send `ROLE_USER` / `ROLE_AGENT`.
    // Normalize to the internal lower-case roles so task history and
    // LLM-provider converters (which branch on `role === 'agent'`) see
    // one vocabulary regardless of client generation.
    if (this.a2xServer.protocolVersion === '1.0') {
      const internalRole = V10_ROLE_TO_INTERNAL.get(message.role as string);
      if (internalRole !== undefined) {
        message.role = internalRole;
      }
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
   * Validate `tasks/get` params per spec a2a-v0.3 §TaskQueryParams.
   * Same shape as `TaskIdParams` plus an optional non-negative integer
   * `historyLength` and an optional `metadata` bag.
   */
  private _validateTaskQueryParams(params: unknown): TaskQueryParams {
    const base = this._validateTaskIdParams(params);
    const p = params as Record<string, unknown>;
    if ('historyLength' in p && p.historyLength !== undefined) {
      if (
        typeof p.historyLength !== 'number' ||
        !Number.isInteger(p.historyLength) ||
        p.historyLength < 0
      ) {
        throw new InvalidParamsError(
          'TaskQueryParams "historyLength" must be a non-negative integer',
        );
      }
    }
    return {
      id: base.id,
      historyLength: p.historyLength as number | undefined,
      metadata: p.metadata as Record<string, unknown> | undefined,
    };
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

    if (this.a2xServer.protocolVersion === '0.3') {
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
   * v0.3 spec `SetTaskPushNotificationConfigRequest.params` is a
   * `TaskPushNotificationConfig` with shape `{ taskId, pushNotificationConfig }`
   * (nested). v1.0 (`a2a-v1.0.0.proto:464`) flattens the same fields onto
   * the request: `{ taskId, id?, url, token?, authentication?, tenant? }`.
   * Branch on `protocolVersion` so a v1.0 client can round-trip the shape
   * the response mapper produces — `V10ResponseMapper.mapPushNotificationConfig`
   * already returns the flat shape, so the validator must accept it back.
   *
   * `pushNotificationConfig.id` (v0.3) and top-level `id` (v1.0) are
   * optional per spec; the server assigns a UUID when the client omits
   * it so the store can key the entry.
   */
  private _validateSetPushNotificationConfigParams(
    params: unknown,
  ): TaskPushNotificationConfig {
    if (!params || typeof params !== 'object') {
      throw new InvalidParamsError(
        'SetPushNotificationConfig requires a "taskId" and push notification fields',
      );
    }

    const p = params as Record<string, unknown>;

    if (typeof p.taskId !== 'string' || (p.taskId as string).trim() === '') {
      throw new InvalidParamsError(
        'SetPushNotificationConfig: "taskId" must be a non-empty string',
      );
    }

    // v1.0 flat shape: read fields from the top level. The presence of a
    // top-level `url` is what disambiguates flat from nested — a v0.3
    // request never has top-level `url`, only `pushNotificationConfig`.
    const isFlat =
      this.a2xServer.protocolVersion === '1.0' &&
      typeof p.url === 'string';

    const source: Record<string, unknown> = isFlat
      ? p
      : ((): Record<string, unknown> => {
          const nested = p.pushNotificationConfig;
          if (!nested || typeof nested !== 'object') {
            throw new InvalidParamsError(
              'SetPushNotificationConfig: "pushNotificationConfig" must be an object',
            );
          }
          return nested as Record<string, unknown>;
        })();

    if (typeof source.url !== 'string' || (source.url as string).trim() === '') {
      const where = isFlat ? '"url"' : '"pushNotificationConfig.url"';
      throw new InvalidParamsError(
        `SetPushNotificationConfig: ${where} must be a non-empty string`,
      );
    }
    if (source.id !== undefined && typeof source.id !== 'string') {
      const where = isFlat ? '"id"' : '"pushNotificationConfig.id"';
      throw new InvalidParamsError(
        `SetPushNotificationConfig: ${where} must be a string when provided`,
      );
    }
    if (source.token !== undefined && typeof source.token !== 'string') {
      const where = isFlat ? '"token"' : '"pushNotificationConfig.token"';
      throw new InvalidParamsError(
        `SetPushNotificationConfig: ${where} must be a string when provided`,
      );
    }
    const authentication =
      source.authentication !== undefined
        ? this._validatePushNotificationAuthentication(source.authentication)
        : undefined;

    // Empty-string id is treated as absent (v1.0 proto-default semantic);
    // the server assigns a UUID so the store can key the entry.
    const clientId =
      typeof source.id === 'string' && source.id.length > 0 ? source.id : undefined;
    const innerConfig: PushNotificationConfig = {
      id: clientId ?? randomUUID(),
      url: source.url,
      ...(source.token !== undefined ? { token: source.token as string } : {}),
      ...(authentication !== undefined ? { authentication } : {}),
    };

    return {
      taskId: p.taskId,
      pushNotificationConfig: innerConfig,
    };
  }

  /**
   * Validate and normalize the inbound `authentication` block of a
   * `pushNotificationConfig` to the internal v0.3 shape
   * `{ schemes: string[], credentials? }`.
   *
   * - v0.3 (`a2a-v0.3.0.json:1879-1897`): `{ schemes: string[], credentials? }`
   *   with `schemes` required and non-empty.
   * - v1.0 (`a2a-v1.0.0.json:466-483`, `a2a-v1.0.0.proto:325-329`):
   *   `{ scheme: string, credentials? }` with `scheme` REQUIRED and
   *   `additionalProperties: false`. Promote `scheme` to `[scheme]` for
   *   storage so `tasks/pushNotificationConfig/{set,get,list}` round-trip
   *   through the same internal shape regardless of wire version.
   */
  private _validatePushNotificationAuthentication(
    raw: unknown,
  ): PushNotificationAuthenticationInfo {
    if (raw === null || typeof raw !== 'object') {
      throw new InvalidParamsError(
        'SetPushNotificationConfig: "pushNotificationConfig.authentication" must be an object when provided',
      );
    }
    const auth = raw as Record<string, unknown>;
    if (auth.credentials !== undefined && typeof auth.credentials !== 'string') {
      throw new InvalidParamsError(
        'SetPushNotificationConfig: "pushNotificationConfig.authentication.credentials" must be a string when provided',
      );
    }

    let schemes: string[];
    if (this.a2xServer.protocolVersion === '1.0') {
      if (typeof auth.scheme !== 'string' || auth.scheme.trim() === '') {
        throw new InvalidParamsError(
          'SetPushNotificationConfig: "pushNotificationConfig.authentication.scheme" must be a non-empty string',
        );
      }
      schemes = [auth.scheme];
    } else {
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
      schemes = auth.schemes as string[];
    }

    return {
      schemes,
      ...(auth.credentials !== undefined ? { credentials: auth.credentials as string } : {}),
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

    if (this.a2xServer.protocolVersion === '0.3') {
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

    if (this.a2xServer.protocolVersion === '0.3') {
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

/**
 * Fold the artifacts one execution produced onto the ones the task
 * already carried.
 *
 * `updateTask` replaces the artifact list, and a continuation turn
 * (`input-required` → resume) starts the executor's list from scratch, so
 * writing that list verbatim would drop artifacts the client was handed
 * on an earlier turn. Same `artifactId` still supersedes, per spec
 * a2a-v0.3 §TaskArtifactUpdateEvent.
 */
function mergeArtifacts(
  prior: readonly Artifact[],
  produced: readonly Artifact[],
): Artifact[] {
  return produced.reduce<Artifact[]>(
    (accumulated, artifact) => applyArtifactUpdate(accumulated, { artifact }),
    [...prior],
  );
}

/**
 * Project a Task snapshot onto the `TaskUpdate` shape so every field the
 * executor may have touched is written back to the store in one call.
 */
function taskUpdateFrom(task: Task): TaskUpdate {
  return {
    status: task.status,
    ...(task.artifacts ? { artifacts: task.artifacts } : {}),
    ...(task.history ? { history: task.history } : {}),
    ...(task.metadata ? { metadata: task.metadata } : {}),
  };
}

/**
 * Trim a Task's `history` to the last `limit` entries without mutating
 * the underlying store entry. Returns the same Task reference when no
 * trimming is needed (limit is undefined or already short enough), so
 * downstream mappers can rely on identity equality where they used to.
 */
function sliceHistory(task: Task, limit?: number): Task {
  if (limit === undefined) return task;
  const history = task.history;
  if (!history) return task;
  if (limit === 0) {
    return { ...task, history: [] };
  }
  if (history.length <= limit) return task;
  return { ...task, history: history.slice(-limit) };
}

/**
 * Parse the extension activation header into a set of URIs. v0.3 clients
 * send `X-A2A-Extensions` (v0.3 extensions topic doc); v1.0 renamed it to
 * `A2A-Extensions` (spec a2a-v1.0 §3.2.6). Both spellings are accepted
 * regardless of the server's protocol version — the header a client
 * picked identifies the client generation, not the payload encoding.
 * Header names are case-insensitive; values may be comma-separated or
 * repeated. Runs against the generic `RequestContext.headers` map
 * populated by the transport adapter (Next.js / Express / etc.).
 */
function parseActivatedExtensions(
  headers: Record<string, string | string[] | undefined>,
): Set<string> {
  const activated = new Set<string>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (lower !== 'x-a2a-extensions' && lower !== 'a2a-extensions') continue;
    const raw = Array.isArray(value) ? value : value ? [value] : [];
    for (const entry of raw) {
      for (const uri of entry.split(',').map((s) => s.trim())) {
        if (uri.length > 0) activated.add(uri);
      }
    }
  }
  return activated;
}

/**
 * Read the `A2A-Version` service parameter (spec a2a-v1.0 §3.2.6),
 * transmitted as an HTTP header per §9.2. Returns the trimmed value, or
 * `undefined` when the header is absent or blank. When the header is
 * repeated, the first non-blank value wins.
 */
function readA2AVersionHeader(
  headers: Record<string, string | string[] | undefined>,
): string | undefined {
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'a2a-version') continue;
    const raw = Array.isArray(value) ? value : value ? [value] : [];
    for (const entry of raw) {
      const trimmed = entry.trim();
      if (trimmed.length > 0) return trimmed;
    }
  }
  return undefined;
}

/**
 * Reduce a version string to its Major.Minor prefix — spec a2a-v1.0
 * requires agents to match the requested `A2A-Version` on Major.Minor,
 * so `0.3.0` must pin the same version as `0.3`. Strings without a
 * numeric Major.Minor prefix are returned as-is (and will fail the
 * version match, which is the correct outcome for garbage input).
 */
function toMajorMinor(version: string): string {
  const match = /^(\d+)\.(\d+)/.exec(version);
  return match ? `${match[1]}.${match[2]}` : version;
}
