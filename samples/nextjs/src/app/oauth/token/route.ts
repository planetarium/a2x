/**
 * POST /oauth/token
 *
 * OAuth2 Token endpoint for Device Code grant (RFC 8628 §3.4).
 * Polled by CLI until the user approves via /device/verify.
 */

import crypto from 'node:crypto';
import { NextResponse } from 'next/server';
import { getByDeviceCode, consumeDeviceCode } from '@/lib/device-store';

export async function POST(request: Request): Promise<Response> {
  const body = await request.text();
  const params = new URLSearchParams(body);

  const grantType = params.get('grant_type');
  if (grantType !== 'urn:ietf:params:oauth:grant-type:device_code') {
    return NextResponse.json(
      { error: 'unsupported_grant_type' },
      { status: 400 },
    );
  }

  const deviceCode = params.get('device_code');
  if (!deviceCode) {
    return NextResponse.json(
      { error: 'invalid_request', error_description: 'device_code is required' },
      { status: 400 },
    );
  }

  // Check if device code exists
  const entry = getByDeviceCode(deviceCode);
  if (!entry) {
    return NextResponse.json(
      { error: 'expired_token', error_description: 'Device code expired or not found' },
      { status: 400 },
    );
  }

  // Not yet approved — tell client to keep polling
  if (!entry.approved) {
    return NextResponse.json(
      { error: 'authorization_pending' },
      { status: 400 },
    );
  }

  // Approved — consume and issue token
  const consumed = consumeDeviceCode(deviceCode);
  if (!consumed) {
    return NextResponse.json(
      { error: 'invalid_grant' },
      { status: 400 },
    );
  }

  const accessToken = crypto.randomUUID();

  // Store the token so the agent's tokenValidator can verify it.
  // We use a simple env-less approach: set it in a global map.
  globalTokens.add(accessToken);

  return NextResponse.json({
    access_token: accessToken,
    token_type: 'Bearer',
    expires_in: 3600,
    scope: consumed.scopes.join(' '),
  });
}

/**
 * Global set of valid access tokens issued by this server.
 * The agent's tokenValidator checks membership here.
 * Attached to globalThis to survive Next.js HMR in dev mode.
 */
const g = globalThis as unknown as { __globalTokens?: Set<string> };
export const globalTokens = (g.__globalTokens ??= new Set<string>());
