/**
 * POST /device/authorize
 *
 * OAuth2 Device Authorization endpoint (RFC 8628 §3.1).
 * Issues a device_code and user_code for CLI/headless clients.
 */

import { NextResponse } from 'next/server';
import { createDeviceCode } from '@/lib/device-store';

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  const params = new URLSearchParams(body);
  const scope = params.get('scope') ?? '';
  const scopes = scope ? scope.split(' ') : [];

  const baseUrl = new URL(request.url).origin;
  const result = createDeviceCode(scopes);

  return NextResponse.json({
    ...result,
    verification_uri: `${baseUrl}/device/verify`,
    verification_uri_complete: `${baseUrl}/device/verify?user_code=${result.user_code}`,
  });
}
