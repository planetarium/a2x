/**
 * Layer 4: SSE (Server-Sent Events) streaming handler.
 */

import type {
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types/task.js';

/**
 * Create a ReadableStream that emits SSE-formatted events from an async generator.
 */
export function createSSEStream(
  events: AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent>,
): ReadableStream {
  const encoder = new TextEncoder();

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const event of events) {
          const eventType = isStatusEvent(event)
            ? 'status_update'
            : 'artifact_update';

          const data = JSON.stringify(event);
          const sseMessage = `event: ${eventType}\ndata: ${data}\n\n`;

          controller.enqueue(encoder.encode(sseMessage));
        }

        // Send a final "done" event
        controller.enqueue(
          encoder.encode('event: done\ndata: {}\n\n'),
        );
        controller.close();
      } catch (error) {
        // Send error as SSE event before closing
        const errorData = JSON.stringify({
          error:
            error instanceof Error ? error.message : 'Unknown error',
        });
        controller.enqueue(
          encoder.encode(`event: error\ndata: ${errorData}\n\n`),
        );
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

function isStatusEvent(
  event: TaskStatusUpdateEvent | TaskArtifactUpdateEvent,
): event is TaskStatusUpdateEvent {
  return 'status' in event;
}
