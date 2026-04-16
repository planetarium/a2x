/**
 * Configuration management for persistent CLI settings.
 *
 * Stores configuration at ~/.a2x/config.json.
 * Provides registry URL resolution with a four-level priority chain.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const CONFIG_DIR = path.join(os.homedir(), '.a2x');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

/** Persistent CLI configuration stored at ~/.a2x/config.json. */
export interface A2xConfig {
  registryUrl?: string;
  [key: string]: unknown;
}

/** Default registry URL used when no override is configured. */
export const DEFAULT_REGISTRY_URL = 'https://a2a-agent-registry.fly.dev';

/**
 * Read the config file at ~/.a2x/config.json.
 * Returns an empty object if the file does not exist or is unparseable.
 */
export function readConfig(): A2xConfig {
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf-8');
    return JSON.parse(raw) as A2xConfig;
  } catch {
    return {};
  }
}

/**
 * Write the config to ~/.a2x/config.json.
 * Creates the directory if it does not exist.
 * Preserves file permissions (mode 0o600 for security).
 */
export function writeConfig(config: A2xConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/**
 * Resolve the registry URL using the priority chain:
 *   1. override parameter (from --registry CLI option)
 *   2. A2X_REGISTRY_URL environment variable
 *   3. registryUrl field in ~/.a2x/config.json
 *   4. DEFAULT_REGISTRY_URL built-in constant
 *
 * @param override - Value from the --registry CLI option, if provided.
 */
export function getRegistryUrl(override?: string): string {
  if (override) return override;
  if (process.env.A2X_REGISTRY_URL) return process.env.A2X_REGISTRY_URL;
  const config = readConfig();
  if (config.registryUrl) return config.registryUrl;
  return DEFAULT_REGISTRY_URL;
}
