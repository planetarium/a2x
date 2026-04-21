/**
 * Local wallet storage for the `a2x wallet` subcommands.
 *
 * Wallets live under `~/.a2x/wallets/<name>.json`, each file chmod 0600
 * so other users on the machine can't read the private key. This is a
 * development-grade storage scheme; for production money, use a
 * hardware wallet or a proper KMS.
 *
 * The active wallet name is tracked in `~/.a2x/config.json` under
 * `activeWallet`.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { privateKeyToAccount } from 'viem/accounts';
import type { LocalAccount } from 'viem';
import { readConfig, writeConfig } from './config.js';

const CONFIG_DIR = path.join(os.homedir(), '.a2x');
const WALLETS_DIR = path.join(CONFIG_DIR, 'wallets');

/** On-disk wallet record. Intentionally plaintext — protected by file perms. */
export interface StoredWallet {
  name: string;
  address: `0x${string}`;
  privateKey: `0x${string}`;
  createdAt: string;
}

export interface WalletSummary {
  name: string;
  address: `0x${string}`;
  active: boolean;
}

export class WalletAlreadyExistsError extends Error {
  constructor(name: string) {
    super(`Wallet "${name}" already exists. Use a different name or delete the old one first.`);
    this.name = 'WalletAlreadyExistsError';
  }
}

export class WalletNotFoundError extends Error {
  constructor(name: string) {
    super(`Wallet "${name}" not found. Run \`a2x wallet list\` to see available wallets.`);
    this.name = 'WalletNotFoundError';
  }
}

export class NoActiveWalletError extends Error {
  constructor() {
    super(
      'No active wallet. Create one with `a2x wallet create` or pick an existing one with `a2x wallet use <name>`.',
    );
    this.name = 'NoActiveWalletError';
  }
}

function walletPath(name: string): string {
  return path.join(WALLETS_DIR, `${name}.json`);
}

function validateName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(
      `Invalid wallet name "${name}". Use letters, digits, dashes, and underscores only (first char alphanumeric).`,
    );
  }
}

function normalizePrivateKey(key: string): `0x${string}` {
  const trimmed = key.trim();
  const withPrefix = trimmed.startsWith('0x') ? trimmed : `0x${trimmed}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(withPrefix)) {
    throw new Error('Private key must be a 32-byte hex string (0x-prefixed or not).');
  }
  return withPrefix as `0x${string}`;
}

function generatePrivateKey(): `0x${string}` {
  // viem ships generatePrivateKey, but pulling in the whole accounts module
  // just for that is overkill — node:crypto does the job and is already in
  // the CLI's dependency tree.
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `0x${hex}` as `0x${string}`;
}

export function listWallets(): WalletSummary[] {
  if (!fs.existsSync(WALLETS_DIR)) return [];
  const active = getActiveWalletName();
  return fs
    .readdirSync(WALLETS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      const raw = fs.readFileSync(path.join(WALLETS_DIR, f), 'utf-8');
      const wallet = JSON.parse(raw) as StoredWallet;
      return {
        name: wallet.name,
        address: wallet.address,
        active: wallet.name === active,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getWallet(name: string): StoredWallet {
  const file = walletPath(name);
  if (!fs.existsSync(file)) {
    throw new WalletNotFoundError(name);
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as StoredWallet;
}

export function hasWallet(name: string): boolean {
  return fs.existsSync(walletPath(name));
}

export function createWallet(
  name: string,
  options: { privateKey?: string; makeActive?: boolean } = {},
): StoredWallet {
  validateName(name);
  if (hasWallet(name)) {
    throw new WalletAlreadyExistsError(name);
  }

  const privateKey = options.privateKey
    ? normalizePrivateKey(options.privateKey)
    : generatePrivateKey();
  const account = privateKeyToAccount(privateKey);

  const record: StoredWallet = {
    name,
    address: account.address,
    privateKey,
    createdAt: new Date().toISOString(),
  };

  fs.mkdirSync(WALLETS_DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(walletPath(name), JSON.stringify(record, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });

  if (options.makeActive || !getActiveWalletName()) {
    setActiveWalletName(name);
  }

  return record;
}

export function deleteWallet(name: string): void {
  if (!hasWallet(name)) {
    throw new WalletNotFoundError(name);
  }
  fs.unlinkSync(walletPath(name));
  if (getActiveWalletName() === name) {
    clearActiveWalletName();
  }
}

export function useWallet(name: string): StoredWallet {
  const wallet = getWallet(name);
  setActiveWalletName(name);
  return wallet;
}

export function getActiveWallet(): StoredWallet | undefined {
  const name = getActiveWalletName();
  if (!name) return undefined;
  try {
    return getWallet(name);
  } catch {
    clearActiveWalletName();
    return undefined;
  }
}

export function requireActiveWallet(): StoredWallet {
  const wallet = getActiveWallet();
  if (!wallet) throw new NoActiveWalletError();
  return wallet;
}

export function activeWalletAccount(): LocalAccount | undefined {
  const wallet = getActiveWallet();
  return wallet ? privateKeyToAccount(wallet.privateKey) : undefined;
}

export function walletAccount(wallet: StoredWallet): LocalAccount {
  return privateKeyToAccount(wallet.privateKey);
}

// ─── Active-wallet pointer (in shared config) ───

function getActiveWalletName(): string | undefined {
  const config = readConfig();
  const active = config.activeWallet;
  return typeof active === 'string' && active.length > 0 ? active : undefined;
}

function setActiveWalletName(name: string): void {
  writeConfig({ ...readConfig(), activeWallet: name });
}

function clearActiveWalletName(): void {
  const config = readConfig();
  delete (config as Record<string, unknown>).activeWallet;
  writeConfig(config);
}
