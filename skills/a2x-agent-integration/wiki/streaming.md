# SSE Streaming

`@a2x/sdk` supports Server-Sent Events (SSE) streaming for the `message/stream` A2A method. The handler returns an `AsyncGenerator` that yields streaming events.

---

## Detecting Streaming vs Synchronous Responses

```typescript
const result = await handler.handle(body, context);

if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
  // Streaming: result is an AsyncGenerator
  // → respond with SSE stream
} else {
  // Synchronous: result is a plain JSON-RPC response object
  // → respond with JSON
}
```

This pattern is the same across all frameworks — only the HTTP response API differs.

---

## createSSEStream Helper

`@a2x/sdk` provides a `createSSEStream()` utility that converts an AsyncGenerator into a `ReadableStream` formatted as SSE:

```typescript
import { createSSEStream } from '@a2x/sdk';

const stream = createSSEStream(result as AsyncGenerator);
// stream is a ReadableStream with SSE-formatted data
```

Each event is formatted as:
```
data: {JSON stringified event}\n\n
```

---

## SSE Headers

Always set these headers for SSE responses:

```typescript
const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  'Connection': 'keep-alive',
  'X-Accel-Buffering': 'no',   // Prevents nginx/reverse proxy buffering
};
```

---

## Framework Patterns

### Next.js App Router (Web Streams API)

```typescript
if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
  const stream = createSSEStream(result as AsyncGenerator);
  return new Response(stream, { headers: SSE_HEADERS });
}
```

### Express (res.write / res.end)

```typescript
if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const stream = createSSEStream(result as AsyncGenerator);
  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(typeof value === 'string' ? value : new TextDecoder().decode(value));
    }
  } catch (error) {
    const errorData = JSON.stringify({
      error: error instanceof Error ? error.message : 'Internal error',
    });
    res.write(`event: error\ndata: ${errorData}\n\n`);
  }
  res.end();
}
```

### NestJS (StreamableFile or raw response)

```typescript
if (result && typeof result === 'object' && Symbol.asyncIterator in result) {
  const stream = createSSEStream(result as AsyncGenerator);
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const reader = stream.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(typeof value === 'string' ? value : new TextDecoder().decode(value));
    }
  } catch (error) {
    res.write(`event: error\ndata: ${JSON.stringify({ error: 'Streaming error' })}\n\n`);
  }
  res.end();
}
```

---

## Manual SSE (Without createSSEStream)

If you prefer manual control:

```typescript
const generator = result as AsyncGenerator;
const encoder = new TextEncoder();

const stream = new ReadableStream({
  async start(controller) {
    try {
      for await (const event of generator) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
      }
    } catch (error) {
      const errData = { jsonrpc: '2.0', error: { code: -32603, message: 'Streaming error' }, id: null };
      controller.enqueue(encoder.encode(`data: ${JSON.stringify(errData)}\n\n`));
    } finally {
      controller.close();
    }
  },
  cancel() {
    generator.return(undefined);  // Clean up on client disconnect
  },
});
```

---

## StreamingMode Configuration

Set on `AgentExecutor`:

```typescript
import { AgentExecutor, StreamingMode } from '@a2x/sdk';

const executor = new AgentExecutor({
  runner,
  runConfig: {
    streamingMode: StreamingMode.SSE,   // Enable streaming
    // streamingMode: StreamingMode.NONE, // Disable (always sync)
  },
});
```

When `StreamingMode.NONE` is set, `message/stream` requests still return a completed Task (not an AsyncGenerator).
