/**
 * Layer 4: Transport - public API
 */

export { DefaultRequestHandler } from './request-handler.js';
export type {
  HandleResult,
  OperationResult,
  OperationOptions,
} from './request-handler.js';
export { JsonRpcRouter } from './jsonrpc-router.js';
export type { MethodHandler, StreamMethodHandler } from './jsonrpc-router.js';
export { createSSEStream } from './sse-handler.js';
export { toA2x, createA2xRequestListener } from './to-a2x.js';
export type {
  ToA2xOptions,
  ToA2xResult,
  A2xRequestListenerOptions,
} from './to-a2x.js';
export {
  HttpJsonRequestHandler,
  A2A_HTTP_JSON_MEDIA_TYPE,
  toHttpJsonErrorResponse,
} from './http-json-handler.js';
export type {
  HttpJsonRequest,
  HttpJsonResponse,
  HttpJsonRequestHandlerOptions,
} from './http-json-handler.js';
