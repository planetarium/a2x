/**
 * Release lookup and self-update plumbing for `a2x update`.
 *
 * The CLI ships from a single `cli-vX.Y.Z` GitHub Release that carries both
 * the platform `pkg` binaries (`a2x-macos-arm64`, `a2x-win-x64.exe`, …) and
 * the npm tarball (`a2x-cli-X.Y.Z.tgz`). SDK releases live in the same repo
 * under `@a2x/sdk@X.Y.Z` tags, so every lookup here filters on the `cli-v`
 * prefix rather than trusting `/releases/latest`.
 *
 * Everything in this module is side-effect free at import time and takes its
 * platform / fetch inputs as parameters so the update logic stays testable.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export const RELEASES_URL =
  'https://api.github.com/repos/planetarium/a2x/releases';

export const RELEASES_PAGE_URL =
  'https://github.com/planetarium/a2x/releases';

/** Tag prefix that distinguishes CLI releases from SDK releases in this repo. */
export const CLI_TAG_PREFIX = 'cli-v';

/** Suffix used for the staged download sitting next to the live binary. */
const STAGED_SUFFIX = '.a2x-update';

/** Suffix used for the displaced binary on Windows, where rename-over fails. */
const BACKUP_SUFFIX = '.a2x-old';

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size?: number;
  /** `sha256:<hex>`, when GitHub has computed a digest for the asset. */
  digest?: string | null;
}

export interface GitHubRelease {
  tag_name: string;
  html_url?: string;
  draft?: boolean;
  prerelease?: boolean;
  assets?: ReleaseAsset[];
}

export interface Semver {
  major: number;
  minor: number;
  patch: number;
  /** Dot-separated prerelease identifiers; empty for a stable release. */
  prerelease: string[];
}

const SEMVER_RE =
  /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/;

export function parseSemver(version: string): Semver | null {
  const match = SEMVER_RE.exec(version.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] ? match[4].split('.') : [],
  };
}

function comparePrerelease(a: string[], b: string[]): number {
  // A stable release outranks any prerelease of the same X.Y.Z.
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const x = a[i];
    const y = b[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (xNum !== yNum) {
      // Numeric identifiers always rank lower than alphanumeric ones.
      return xNum ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/**
 * Compare two semver strings. Returns a negative number when `a` is older,
 * zero when equal, positive when `a` is newer. Unparseable versions sort
 * below everything so a malformed local version still sees updates.
 */
export function compareSemver(a: string, b: string): number {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (!left && !right) return 0;
  if (!left) return -1;
  if (!right) return 1;
  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** Extract the CLI version from a `cli-vX.Y.Z` tag, or null for other tags. */
export function versionFromTag(tag: string): string | null {
  if (!tag.startsWith(CLI_TAG_PREFIX)) return null;
  const version = tag.slice(CLI_TAG_PREFIX.length);
  return parseSemver(version) ? version : null;
}

/**
 * Pick the newest published `cli-v*` release, ignoring drafts, prereleases,
 * and the `@a2x/sdk@*` releases that share this repo.
 */
export function pickLatestCliRelease(
  releases: GitHubRelease[],
): { release: GitHubRelease; version: string } | null {
  let best: { release: GitHubRelease; version: string } | null = null;
  for (const release of releases) {
    if (release.draft || release.prerelease) continue;
    const version = versionFromTag(release.tag_name ?? '');
    if (!version) continue;
    if (!best || compareSemver(version, best.version) > 0) {
      best = { release, version };
    }
  }
  return best;
}

/**
 * Release asset name for a platform/arch pair, matching what
 * `.github/workflows/release-cli.yml` uploads. Returns null for targets we
 * do not build a binary for.
 */
export function assetNameFor(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
): string | null {
  if (platform === 'darwin') {
    if (arch === 'x64') return 'a2x-macos-x64';
    if (arch === 'arm64') return 'a2x-macos-arm64';
    return null;
  }
  if (platform === 'linux') {
    if (arch === 'x64') return 'a2x-linux-x64';
    if (arch === 'arm64') return 'a2x-linux-arm64';
    return null;
  }
  if (platform === 'win32') {
    return arch === 'x64' ? 'a2x-win-x64.exe' : null;
  }
  return null;
}

/** Locate the npm tarball asset (`a2x-cli-X.Y.Z.tgz`) in a release. */
export function findTarballAsset(release: GitHubRelease): ReleaseAsset | null {
  return release.assets?.find((a) => a.name.endsWith('.tgz')) ?? null;
}

export function findAsset(
  release: GitHubRelease,
  name: string,
): ReleaseAsset | null {
  return release.assets?.find((a) => a.name === name) ?? null;
}

/**
 * How this process was installed, which decides how it can update itself.
 *
 * - `binary`  — a `pkg` single-file executable; replace it in place.
 * - `npm-global` — `dist/index.js` under a global `node_modules/@a2x/cli`;
 *   reinstall from the release tarball.
 * - `source`  — a workspace checkout (`pnpm cli:install`, `tsx src/index.ts`);
 *   only the human can update that.
 */
export type InstallKind = 'binary' | 'npm-global' | 'source';

export interface InstallInfo {
  kind: InstallKind;
  /** The file that would be replaced, for `binary` installs. */
  execPath: string;
}

export function detectInstall(
  entry: string | undefined = process.argv[1],
  execPath: string = process.execPath,
): InstallInfo {
  // @yao-pkg/pkg exposes `process.pkg` and mounts the bundle under /snapshot.
  const isPkg =
    Boolean((process as NodeJS.Process & { pkg?: unknown }).pkg) ||
    /^(?:[A-Za-z]:)?[\\/]snapshot[\\/]/.test(entry ?? '');
  if (isPkg) return { kind: 'binary', execPath };

  // A global npm install is reached through a bin symlink (`/usr/local/bin/a2x`),
  // which `process.argv[1]` keeps unresolved — check the real file too.
  const candidates = [entry];
  if (entry) {
    try {
      candidates.push(fs.realpathSync(entry));
    } catch {
      // Entry point vanished or is not a real path; the raw value has to do.
    }
  }
  const isNpmGlobal = candidates.some((candidate) =>
    toPosix(candidate).includes('node_modules/@a2x/cli/'),
  );
  return { kind: isNpmGlobal ? 'npm-global' : 'source', execPath };
}

function toPosix(p: string | undefined): string {
  return (p ?? '').split(path.win32.sep).join(path.posix.sep);
}

/** Optional GitHub credential, used purely to lift the anonymous rate limit. */
function githubToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env.A2X_GITHUB_TOKEN || env.GITHUB_TOKEN || env.GH_TOKEN || undefined;
}

export interface FetchReleasesOptions {
  fetchImpl?: typeof fetch;
  url?: string;
  env?: NodeJS.ProcessEnv;
}

export async function fetchCliReleases(
  options: FetchReleasesOptions = {},
): Promise<GitHubRelease[]> {
  const { fetchImpl = fetch, url = RELEASES_URL, env = process.env } = options;
  const token = githubToken(env);
  const response = await fetchImpl(`${url}?per_page=30`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'a2x-cli',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });

  if (!response.ok) {
    const hint =
      response.status === 403 && !token
        ? ' (GitHub API rate limit — set GITHUB_TOKEN to raise it)'
        : '';
    throw new Error(
      `Failed to query GitHub releases: ${response.status} ${response.statusText}${hint}`,
    );
  }

  const body = (await response.json()) as unknown;
  return Array.isArray(body) ? (body as GitHubRelease[]) : [];
}

export interface DownloadOptions {
  fetchImpl?: typeof fetch;
  /** Called with bytes received and, when the server reports it, the total. */
  onProgress?: (received: number, total: number | null) => void;
}

/**
 * Download `url` to `destPath` and return the SHA-256 of what landed on disk.
 * The file is created with mode 0o755 so a downloaded binary is executable.
 */
export async function downloadTo(
  url: string,
  destPath: string,
  options: DownloadOptions = {},
): Promise<string> {
  const { fetchImpl = fetch, onProgress } = options;
  const response = await fetchImpl(url, {
    headers: { Accept: 'application/octet-stream', 'User-Agent': 'a2x-cli' },
    redirect: 'follow',
  });
  if (!response.ok || !response.body) {
    throw new Error(
      `Download failed: ${response.status} ${response.statusText} (${url})`,
    );
  }

  const lengthHeader = response.headers.get('content-length');
  const total = lengthHeader ? Number(lengthHeader) : null;
  const hash = createHash('sha256');
  let received = 0;

  const tap = new Transform({
    transform(chunk: Buffer, _enc, callback) {
      hash.update(chunk);
      received += chunk.length;
      onProgress?.(received, Number.isFinite(total) ? total : null);
      callback(null, chunk);
    },
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]),
      tap,
      fs.createWriteStream(destPath, { mode: 0o755 }),
    );
  } catch (err) {
    fs.rmSync(destPath, { force: true });
    throw err;
  }

  return hash.digest('hex');
}

/**
 * Compare a GitHub asset digest (`sha256:<hex>`) against a computed hash.
 * Assets predating GitHub's digest field verify vacuously.
 */
export function digestMatches(
  expected: string | null | undefined,
  actualSha256: string,
): boolean {
  if (!expected) return true;
  const [algorithm, value] = expected.split(':');
  if (algorithm !== 'sha256' || !value) return true;
  return value.toLowerCase() === actualSha256.toLowerCase();
}

export function stagedPathFor(target: string): string {
  return `${target}${STAGED_SUFFIX}`;
}

/** Throw an actionable error when the binary's directory is not writable. */
export function assertWritable(target: string): void {
  const dir = path.dirname(target);
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch {
    throw new Error(
      `No write permission for ${dir}. Re-run with elevated privileges ` +
        `(e.g. \`sudo a2x update\`) or reinstall from ${RELEASES_PAGE_URL}.`,
    );
  }
}

/**
 * Swap the staged download in for the live executable.
 *
 * POSIX can rename over a running binary — the kernel keeps the old inode
 * alive for this process. Windows cannot, so the running `.exe` is moved
 * aside first and swept up by a later run.
 */
export function replaceExecutable(target: string, staged: string): void {
  if (process.platform !== 'win32') {
    fs.renameSync(staged, target);
    return;
  }

  const backup = `${target}${BACKUP_SUFFIX}-${process.pid}`;
  fs.renameSync(target, backup);
  try {
    fs.renameSync(staged, target);
  } catch (err) {
    fs.renameSync(backup, target);
    throw err;
  }
}

/** Best-effort removal of Windows backups left behind by earlier updates. */
export function cleanupStaleBackups(target: string): void {
  const dir = path.dirname(target);
  const prefix = `${path.basename(target)}${BACKUP_SUFFIX}`;
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    try {
      fs.rmSync(path.join(dir, entry), { force: true });
    } catch {
      // Still locked by a running process; the next update will retry.
    }
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KiB', 'MiB', 'GiB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
