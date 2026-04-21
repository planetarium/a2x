import { NextRequest } from 'next/server';
import { AgentCardHandler } from '../handler';

export async function GET(request: NextRequest) {
  return AgentCardHandler(request);
}
