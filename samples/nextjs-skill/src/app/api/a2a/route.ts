import { NextResponse } from "next/server";
import { handler } from "@/lib/a2x-setup";
import { createSSEStream, getHttpStatus, getHttpHeaders } from "@a2x/sdk";
import type { RequestContext } from "@a2x/sdk";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", error: { code: -32700, message: "Parse error" }, id: null },
      { status: 400 },
    );
  }

  const context: RequestContext = {
    headers: Object.fromEntries(request.headers.entries()),
    query: Object.fromEntries(new URL(request.url).searchParams.entries()),
  };

  const result = await handler.handle(body, context);
  const status = getHttpStatus(result);
  const extraHeaders = getHttpHeaders(result);

  if (result.body && typeof result.body === "object" && Symbol.asyncIterator in result.body) {
    const stream = createSSEStream(result.body as AsyncGenerator<never>);
    return new Response(stream, { headers: { ...SSE_HEADERS, ...extraHeaders } });
  }

  return NextResponse.json(result.body, { status, headers: extraHeaders });
}
