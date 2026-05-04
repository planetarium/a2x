#!/usr/bin/env node
/**
 * Guard against samples re-implementing helpers the SDK already provides.
 *
 * After the x402 surface refactor, the agent-driven sample (and any
 * future sample) should never need to copy the SDK's
 * payment-status / accept-normalization / sentinel helpers — those live
 * in `@a2x/sdk` and are imported. This script greps for the identifier
 * names that used to be replicated in samples/ and fails CI if any reappear.
 *
 * The list is intentionally narrow (Q-18 in the tech spec): each
 * identifier is a name a sample once carried verbatim, so its presence
 * almost always signals a regression to the pre-refactor copy-paste
 * pattern. Add identifiers here when a future sample is found re-implementing
 * something the SDK exports.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const SAMPLES_DIR = resolve(REPO_ROOT, 'samples');

const FORBIDDEN_IDENTIFIERS = [
  // Old custom-executor internals copied into samples.
  'applyPaymentRequiredStatus',
  'applyVerifiedStatus',
  'applyRejectedStatus',
  'applyFailedPaymentStatus',
  'attachReceipt',
  'normalizeAccept',
  'pickRequirement',
  'getPaymentStatus',
  'getPaymentPayload',
  // Sentinel-pattern symbols the agent-driven sample used to define.
  'PAYMENT_REQUIRED_SENTINEL_MIME',
  'PAYMENT_SETTLED_SESSION_KEY',
];

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist' || entry === 'build') {
      continue;
    }
    const full = join(dir, entry);
    let stats;
    try {
      stats = await stat(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      yield* walk(full);
    } else if (
      stats.isFile() &&
      (entry.endsWith('.ts') || entry.endsWith('.tsx'))
    ) {
      yield full;
    }
  }
}

async function main() {
  const offenders = [];
  for await (const file of walk(SAMPLES_DIR)) {
    const content = await readFile(file, 'utf-8');
    for (const identifier of FORBIDDEN_IDENTIFIERS) {
      if (content.includes(identifier)) {
        offenders.push({ file, identifier });
      }
    }
  }

  if (offenders.length === 0) {
    console.log(
      `samples-clone-check: clean (${FORBIDDEN_IDENTIFIERS.length} identifiers checked)`,
    );
    return;
  }

  console.error('samples-clone-check: forbidden identifiers found in samples/:');
  for (const { file, identifier } of offenders) {
    console.error(`  ${file.replace(REPO_ROOT + '/', '')}: ${identifier}`);
  }
  console.error(
    '\nThese identifiers indicate a sample is replicating helpers the SDK already provides via @a2x/sdk.',
  );
  process.exit(1);
}

main().catch((error) => {
  console.error('samples-clone-check: unexpected error', error);
  process.exit(2);
});
