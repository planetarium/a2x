import { NextResponse } from "next/server";
import { handler } from "@/lib/a2x-setup";
import { createSSEStream } from "@a2x/sdk";
import type { RequestContext } from "@a2x/sdk";

const SSE_HEADERS = {
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  Connection: "keep-alive",
  "X-Accel-Buffering": "no",
} as const;

export async function POST(request: Request): Promise<Response> {
  // JSON-RPC over HTTP convention: parse and handler errors become
  // JSON-RPC error responses with HTTP 200, not 4xx/5xx — clients that
  // skip body parsing on transport errors still see the code.
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } },
      { status: 200 },
    );
  }

  const context: RequestContext = {
    headers: Object.fromEntries(request.headers.entries()),
    query: Object.fromEntries(new URL(request.url).searchParams.entries()),
  };

  let result: Awaited<ReturnType<typeof handler.handle>>;
  try {
    result = await handler.handle(body, context);
  } catch (err) {
    const id = (body as { id?: unknown } | undefined)?.id ?? null;
    return NextResponse.json(
      {
        jsonrpc: "2.0",
        id,
        error: {
          code: -32603,
          message: err instanceof Error ? err.message : "Internal error",
        },
      },
      { status: 200 },
    );
  }

  if (result && typeof result === "object" && Symbol.asyncIterator in result) {
    const stream = createSSEStream(result as AsyncGenerator<never>);
    return new Response(stream, { headers: SSE_HEADERS });
  }

  return NextResponse.json(result);
}
