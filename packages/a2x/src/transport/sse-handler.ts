/**
 * Layer 4: SSE (Server-Sent Events) streaming handler.
 *
 * Per A2A spec a2a-v0.3 §SendStreamingMessageSuccessResponse, every
 * chunk in a `message/stream` or `tasks/resubscribe` SSE response is a
 * full JSON-RPC success response keyed by the request id:
 *
 *   { "jsonrpc": "2.0", "id": <correlation id>, "result": <event> }
 *
 * The wrapping into that envelope is done upstream — in
 * DefaultRequestHandler's stream methods, where the request id is in
 * scope. This file is the transport-level SSE encoder: it takes
 * already-shaped values and emits them as data-only SSE chunks (no
 * `event:` field, no terminator chunk). Stream end is signalled by
 * connection close after the last event, which the spec already
 * requires the handler to mark with `final: true` (v0.3) or by simply
 * stopping (v1.0).
 */

/**
 * Create a ReadableStream that JSON-encodes each value yielded by the
 * generator as an SSE `data:` chunk.
 *
 * The caller is responsible for shaping each yielded value into a
 * JSON-RPC frame. See the file header for why.
 */
export function createSSEStream(
  events: AsyncGenerator<unknown>,
): ReadableStream {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of events) {
          const data = JSON.stringify(event);
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        }
        controller.close();
      } catch (error) {
        // Mid-stream errors are spec-undefined for SSE A2A streaming.
        // We emit a single transport-level error chunk (data-only, not
        // a JSON-RPC envelope — we no longer hold the request id at
        // this layer) and close. Handlers that want the spec-shaped
        // {jsonrpc, id, error} body should yield it themselves before
        // returning instead of throwing.
        const errorData = JSON.stringify({
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        controller.enqueue(encoder.encode(`data: ${errorData}\n\n`));
        controller.close();
      }
    },

    cancel() {
      // Propagate client disconnect up the for-await chain so each finally
      // block runs and the shared AbortController is aborted.
      void events.return(undefined).catch(() => {});
    },
  });
}
