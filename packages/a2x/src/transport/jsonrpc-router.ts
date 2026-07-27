/**
 * Layer 4: JSON-RPC method router.
 */

import type { JSONRPCRequest, JSONRPCResponse } from '../types/jsonrpc.js';
import {
  MethodNotFoundError,
  type A2AError,
} from '../types/errors.js';

/**
 * Per-request routing context threaded from the transport layer to method
 * handlers. Carries request-scoped state that isn't part of the JSON-RPC
 * envelope — e.g. the A2A extension URIs the client activated via the
 * `X-A2A-Extensions` header.
 */
export interface RouteContext {
  activatedExtensions?: readonly string[];
}

export type MethodHandler = (
  params: unknown,
  request: JSONRPCRequest,
  context?: RouteContext,
) => Promise<unknown>;

export type StreamMethodHandler = (
  params: unknown,
  request: JSONRPCRequest,
  context?: RouteContext,
) => AsyncGenerator<unknown>;

export class JsonRpcRouter {
  private readonly handlers = new Map<string, MethodHandler>();
  private readonly streamHandlers = new Map<string, StreamMethodHandler>();

  /**
   * Register a standard (non-streaming) method handler.
   */
  registerMethod(method: string, handler: MethodHandler): void {
    this.handlers.set(method, handler);
  }

  /**
   * Register a streaming method handler.
   */
  registerStreamMethod(method: string, handler: StreamMethodHandler): void {
    this.streamHandlers.set(method, handler);
  }

  /**
   * Check if a method is registered as a streaming method.
   */
  isStreamMethod(method: string): boolean {
    return this.streamHandlers.has(method);
  }

  /**
   * Route a JSON-RPC request to the appropriate handler.
   */
  async route(
    request: JSONRPCRequest,
    context?: RouteContext,
  ): Promise<JSONRPCResponse> {
    const handler = this.handlers.get(request.method);
    if (!handler) {
      const error = new MethodNotFoundError(
        `Method '${request.method}' not found`,
      );
      return {
        jsonrpc: '2.0',
        id: request.id,
        error: error.toJSONRPCError(),
      };
    }

    try {
      const result = await handler(request.params, request, context);
      return {
        jsonrpc: '2.0',
        id: request.id,
        result,
      };
    } catch (err) {
      if (err && typeof err === 'object' && 'toJSONRPCError' in err) {
        return {
          jsonrpc: '2.0',
          id: request.id,
          error: (err as A2AError).toJSONRPCError(),
        };
      }
      throw err;
    }
  }

  /**
   * Route a streaming JSON-RPC request, returning an AsyncGenerator.
   */
  routeStream(
    request: JSONRPCRequest,
    context?: RouteContext,
  ): AsyncGenerator<unknown> {
    const handler = this.streamHandlers.get(request.method);
    if (!handler) {
      throw new MethodNotFoundError(
        `Stream method '${request.method}' not found`,
      );
    }
    return handler(request.params, request, context);
  }

  /**
   * Get all supported methods.
   */
  getSupportedMethods(): string[] {
    return [
      ...this.handlers.keys(),
      ...this.streamHandlers.keys(),
    ];
  }
}
