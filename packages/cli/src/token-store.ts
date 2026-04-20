/**
 * File-based token store for persisting auth credentials across CLI invocations.
 *
 * Stores credentials per agent URL at ~/.a2x/tokens.json.
 * Each entry maps a scheme class name to its raw credential value.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const STORE_DIR = path.join(os.homedir(), '.a2x');
const STORE_PATH = path.join(STORE_DIR, 'tokens.json');

interface StoredCredential {
  schemeClass: string;
  credential: string;
}

type StoreData = Record<string, StoredCredential[]>;

function readStore(): StoreData {
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf-8');
    return JSON.parse(raw) as StoreData;
  } catch {
    return {};
  }
}

function writeStore(data: StoreData): void {
  fs.mkdirSync(STORE_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(STORE_PATH, JSON.stringify(data, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
  fs.chmodSync(STORE_PATH, 0o600);
}

export function loadCredentials(agentUrl: string): StoredCredential[] | undefined {
  const store = readStore();
  return store[agentUrl];
}

export function saveCredentials(
  agentUrl: string,
  credentials: StoredCredential[],
): void {
  const store = readStore();
  store[agentUrl] = credentials;
  writeStore(store);
}

export function clearCredentials(agentUrl: string): void {
  const store = readStore();
  delete store[agentUrl];
  writeStore(store);
}
