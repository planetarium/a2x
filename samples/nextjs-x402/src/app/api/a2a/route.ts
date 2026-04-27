import { NextResponse } from 'next/server';
import { handler } from '@/lib/a2x-setup';
import { createSSEStream, getHttpStatus, getHttpHeaders } from '@a2x/sdk';
import type { RequestContext } from '@a2x/sdk';

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
} as const;

/**
 * Toggle request/response logging with A2A_LOG=1. Stream events are logged
 * one-per-line as they pass through to the SSE response, so this shouldn't
 * change the observable behaviour of the agent — it just gives you a
 * transcript in the dev server console.
 */
const LOGGING = process.env.A2A_LOG === '1';

function log(label: string, payload: unknown): void {
  if (!LOGGING) return;
  // Stringify in one go so the line stays together in the log stream.
  console.log(`[a2a] ${label} ${JSON.stringify(payload)}`);
}

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null },
      { status: 400 },
    );
  }

  log('request', body);

  const context: RequestContext = {
    headers: Object.fromEntries(request.headers.entries()),
    query: Object.fromEntries(new URL(request.url).searchParams.entries()),
  };

  const result = await handler.handle(body, context);
  const status = getHttpStatus(result);
  const extraHeaders = getHttpHeaders(result);

  if (result.body && typeof result.body === 'object' && Symbol.asyncIterator in result.body) {
    const source = result.body as AsyncGenerator<unknown>;
    const logged: AsyncGenerator<unknown> = LOGGING
      ? (async function* () {
          let i = 0;
          try {
            for await (const event of source) {
              log(`stream-event[${i++}]`, event);
              yield event;
            }
          } finally {
            log('stream-end', { count: i });
          }
        })()
      : source;
    const stream = createSSEStream(logged as AsyncGenerator<never>);
    return new Response(stream, { headers: { ...SSE_HEADERS, ...extraHeaders } });
  }

  log('response', result.body);
  return NextResponse.json(result.body, { status, headers: extraHeaders });
}
