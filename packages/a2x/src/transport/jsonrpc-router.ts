/**
 * Layer 4: JSON-RPC method router.
 */

import type { JSONRPCRequest, JSONRPCResponse } from '../types/jsonrpc.js';
import { A2A_METHODS } from '../types/jsonrpc.js';
import {
  MethodNotFoundError,
  type A2AError,
} from '../types/errors.js';

export type MethodHandler = (
  params: unknown,
  request: JSONRPCRequest,
) => Promise<unknown>;

export type StreamMethodHandler = (
  params: unknown,
  request: JSONRPCRequest,
) => ReadableStream;

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
  async route(request: JSONRPCRequest): Promise<JSONRPCResponse> {
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
      const result = await handler(request.params, request);
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
   * Route a streaming JSON-RPC request.
   */
  routeStream(request: JSONRPCRequest): ReadableStream {
    const handler = this.streamHandlers.get(request.method);
    if (!handler) {
      throw new MethodNotFoundError(
        `Stream method '${request.method}' not found`,
      );
    }
    return handler(request.params, request);
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
