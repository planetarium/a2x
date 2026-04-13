import { NextRequest, NextResponse } from "next/server";
import { a2xAgent } from "@/lib/a2x-setup";

export async function AgentCardHandler(request: NextRequest) {
  const version =
    request.nextUrl.searchParams.get("version") ?? undefined;

  try {
    const card = a2xAgent.getAgentCard(version);
    return NextResponse.json(card);
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Internal error" },
      { status: 500 },
    );
  }
}
