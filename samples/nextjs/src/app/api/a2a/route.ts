import { NextResponse } from "next/server";
import { handler } from "@/lib/a2x-setup";
import { createSSEStream } from "@a2x/a2x";
import type { RequestContext } from "@a2x/a2x";

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

  // Build framework-agnostic RequestContext for authentication
  const context: RequestContext = {
    headers: Object.fromEntries(request.headers.entries()),
    query: Object.fromEntries(new URL(request.url).searchParams.entries()),
  };

  const result = await handler.handle(body, context);

  // Streaming → AsyncGenerator → SSE response
  if (result && typeof result === "object" && Symbol.asyncIterator in result) {
    const stream = createSSEStream(
      result as AsyncGenerator<never>,
    );
    return new Response(stream, { headers: SSE_HEADERS });
  }

  // Synchronous → JSON response
  return NextResponse.json(result);
}
