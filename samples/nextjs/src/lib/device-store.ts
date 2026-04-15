/**
 * In-memory store for OAuth2 Device Code flow.
 *
 * Tracks issued device codes, their approval status, and expiration.
 * Lost on server restart — suitable for development/demo only.
 */

import crypto from 'node:crypto';

export interface DeviceCodeEntry {
  deviceCode: string;
  userCode: string;
  scopes: string[];
  approved: boolean;
  expiresAt: number;
}

const g = globalThis as unknown as { __deviceStore?: Map<string, DeviceCodeEntry> };
const store = (g.__deviceStore ??= new Map<string, DeviceCodeEntry>());

const DEVICE_CODE_TTL = 300; // 5 minutes
const POLL_INTERVAL = 5;     // seconds

function generateUserCode(): string {
  // 8-char alphanumeric, split with dash for readability: ABCD-1234
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function createDeviceCode(scopes: string[]) {
  const deviceCode = crypto.randomUUID();
  const userCode = generateUserCode();
  const expiresAt = Date.now() + DEVICE_CODE_TTL * 1000;

  const entry: DeviceCodeEntry = {
    deviceCode,
    userCode,
    scopes,
    approved: false,
    expiresAt,
  };

  store.set(deviceCode, entry);

  return {
    device_code: deviceCode,
    user_code: userCode,
    expires_in: DEVICE_CODE_TTL,
    interval: POLL_INTERVAL,
  };
}

export function getByDeviceCode(deviceCode: string): DeviceCodeEntry | undefined {
  const entry = store.get(deviceCode);
  if (!entry) return undefined;

  // Expired — clean up
  if (Date.now() > entry.expiresAt) {
    store.delete(deviceCode);
    return undefined;
  }

  return entry;
}

export function getByUserCode(userCode: string): DeviceCodeEntry | undefined {
  for (const entry of store.values()) {
    if (entry.userCode === userCode && Date.now() <= entry.expiresAt) {
      return entry;
    }
  }
  return undefined;
}

export function approveDeviceCode(userCode: string): boolean {
  const entry = getByUserCode(userCode);
  if (!entry) return false;
  entry.approved = true;
  return true;
}

export function consumeDeviceCode(deviceCode: string): DeviceCodeEntry | undefined {
  const entry = getByDeviceCode(deviceCode);
  if (!entry || !entry.approved) return undefined;
  store.delete(deviceCode);
  return entry;
}
