/** Protocol bindings implemented by the core SDK. */
export const A2A_TRANSPORTS = {
  JSONRPC: 'JSONRPC',
  HTTP_JSON: 'HTTP+JSON',
} as const;

export type A2ATransport = (typeof A2A_TRANSPORTS)[keyof typeof A2A_TRANSPORTS];
