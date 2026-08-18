/**
 * Tests for the `a2x update` release-resolution logic: picking the newest
 * `cli-v*` release out of a repo that also publishes `@a2x/sdk@*` releases,
 * mapping the running platform onto a release asset, verifying the downloaded
 * binary's digest, and swapping it in for the live executable.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assetNameFor,
  compareSemver,
  detectInstall,
  digestMatches,
  downloadTo,
  fetchCliReleases,
  findAsset,
  findTarballAsset,
  formatBytes,
  parseSemver,
  pickLatestCliRelease,
  replaceExecutable,
  stagedPathFor,
  versionFromTag,
  type GitHubRelease,
} from '../updater.js';

function release(
  tag: string,
  extra: Partial<GitHubRelease> = {},
): GitHubRelease {
  return { tag_name: tag, assets: [], ...extra };
}

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a2x-updater-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) {
    fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('parseSemver', () => {
  it('parses stable and prerelease versions', () => {
    expect(parseSemver('1.2.3')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: [],
    });
    expect(parseSemver('1.2.3-rc.1')).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      prerelease: ['rc', '1'],
    });
    expect(parseSemver('1.2.3+build.5')?.prerelease).toEqual([]);
  });

  it('rejects non-semver input', () => {
    expect(parseSemver('v1.2.3')).toBeNull();
    expect(parseSemver('1.2')).toBeNull();
    expect(parseSemver('latest')).toBeNull();
  });
});

describe('compareSemver', () => {
  it('orders by major, minor, then patch', () => {
    expect(compareSemver('0.4.0', '0.3.0')).toBeGreaterThan(0);
    expect(compareSemver('0.3.0', '0.3.1')).toBeLessThan(0);
    expect(compareSemver('1.0.0', '0.99.99')).toBeGreaterThan(0);
    expect(compareSemver('0.3.0', '0.3.0')).toBe(0);
  });

  it('compares numerically, not lexicographically', () => {
    expect(compareSemver('0.10.0', '0.9.0')).toBeGreaterThan(0);
  });

  it('ranks a stable release above its prerelease', () => {
    expect(compareSemver('0.4.0', '0.4.0-rc.1')).toBeGreaterThan(0);
    expect(compareSemver('0.4.0-rc.2', '0.4.0-rc.10')).toBeLessThan(0);
  });

  it('treats an unparseable version as older so updates still surface', () => {
    expect(compareSemver('0.0.0-dev', '0.3.0')).toBeLessThan(0);
    expect(compareSemver('garbage', '0.3.0')).toBeLessThan(0);
  });
});

describe('versionFromTag', () => {
  it('accepts CLI tags and rejects SDK tags', () => {
    expect(versionFromTag('cli-v0.3.0')).toBe('0.3.0');
    expect(versionFromTag('@a2x/sdk@0.20.0')).toBeNull();
    expect(versionFromTag('cli-vnightly')).toBeNull();
  });
});

describe('pickLatestCliRelease', () => {
  it('ignores SDK releases sharing the repo', () => {
    const picked = pickLatestCliRelease([
      release('@a2x/sdk@0.20.0'),
      release('cli-v0.3.0'),
      release('@a2x/sdk@0.19.0'),
    ]);
    expect(picked?.version).toBe('0.3.0');
  });

  it('picks the highest version regardless of listing order', () => {
    const picked = pickLatestCliRelease([
      release('cli-v0.3.0'),
      release('cli-v0.10.0'),
      release('cli-v0.9.1'),
    ]);
    expect(picked?.version).toBe('0.10.0');
  });

  it('skips drafts and prereleases', () => {
    const picked = pickLatestCliRelease([
      release('cli-v0.5.0', { draft: true }),
      release('cli-v0.4.0', { prerelease: true }),
      release('cli-v0.3.0'),
    ]);
    expect(picked?.version).toBe('0.3.0');
  });

  it('returns null when the repo has no CLI release', () => {
    expect(pickLatestCliRelease([release('@a2x/sdk@0.20.0')])).toBeNull();
    expect(pickLatestCliRelease([])).toBeNull();
  });
});

describe('assetNameFor', () => {
  it('maps supported targets onto release asset names', () => {
    expect(assetNameFor('darwin', 'arm64')).toBe('a2x-macos-arm64');
    expect(assetNameFor('darwin', 'x64')).toBe('a2x-macos-x64');
    expect(assetNameFor('linux', 'arm64')).toBe('a2x-linux-arm64');
    expect(assetNameFor('linux', 'x64')).toBe('a2x-linux-x64');
    expect(assetNameFor('win32', 'x64')).toBe('a2x-win-x64.exe');
  });

  it('returns null for targets with no published binary', () => {
    expect(assetNameFor('win32', 'arm64')).toBeNull();
    expect(assetNameFor('linux', 'ppc64')).toBeNull();
    expect(assetNameFor('freebsd', 'x64')).toBeNull();
  });
});

describe('asset lookup', () => {
  const rel = release('cli-v0.3.0', {
    assets: [
      {
        name: 'a2x-cli-0.3.0.tgz',
        browser_download_url: 'https://example.test/a2x-cli-0.3.0.tgz',
      },
      {
        name: 'a2x-macos-arm64',
        browser_download_url: 'https://example.test/a2x-macos-arm64',
      },
    ],
  });

  it('finds a binary asset by exact name', () => {
    expect(findAsset(rel, 'a2x-macos-arm64')?.browser_download_url).toBe(
      'https://example.test/a2x-macos-arm64',
    );
    expect(findAsset(rel, 'a2x-linux-x64')).toBeNull();
  });

  it('finds the npm tarball', () => {
    expect(findTarballAsset(rel)?.name).toBe('a2x-cli-0.3.0.tgz');
    expect(findTarballAsset(release('cli-v0.3.0'))).toBeNull();
  });
});

describe('detectInstall', () => {
  it('detects a pkg binary from its snapshot entry point', () => {
    expect(detectInstall('/snapshot/cli/bin-bundle/a2x.cjs', '/usr/local/bin/a2x')).toEqual({
      kind: 'binary',
      execPath: '/usr/local/bin/a2x',
    });
    expect(
      detectInstall('C:\\snapshot\\cli\\bin-bundle\\a2x.cjs', 'C:\\a2x.exe').kind,
    ).toBe('binary');
  });

  it('detects a global npm install from its module path', () => {
    expect(
      detectInstall('/usr/local/lib/node_modules/@a2x/cli/dist/index.js').kind,
    ).toBe('npm-global');
    expect(
      detectInstall('C:\\npm\\node_modules\\@a2x\\cli\\dist\\index.js').kind,
    ).toBe('npm-global');
  });

  it('falls back to source for a workspace checkout', () => {
    expect(detectInstall('/home/dev/a2x/packages/cli/dist/index.js').kind).toBe(
      'source',
    );
    expect(detectInstall(undefined).kind).toBe('source');
  });
});

describe('digestMatches', () => {
  const sha = 'a'.repeat(64);

  it('accepts a matching sha256 digest regardless of case', () => {
    expect(digestMatches(`sha256:${sha}`, sha)).toBe(true);
    expect(digestMatches(`sha256:${sha.toUpperCase()}`, sha)).toBe(true);
  });

  it('rejects a mismatching digest', () => {
    expect(digestMatches(`sha256:${'b'.repeat(64)}`, sha)).toBe(false);
  });

  it('verifies vacuously when the release predates asset digests', () => {
    expect(digestMatches(null, sha)).toBe(true);
    expect(digestMatches(undefined, sha)).toBe(true);
    expect(digestMatches('md5:whatever', sha)).toBe(true);
  });
});

describe('downloadTo', () => {
  const payload = 'a2x binary bytes';
  const payloadSha = createHash('sha256').update(payload).digest('hex');

  function fakeFetch(body: string, headers: Record<string, string> = {}) {
    return (async () =>
      new Response(body, { status: 200, headers })) as unknown as typeof fetch;
  }

  it('writes the body to disk and returns its sha256', async () => {
    const dest = path.join(makeTempDir(), 'a2x');
    const digest = await downloadTo('https://example.test/a2x', dest, {
      fetchImpl: fakeFetch(payload),
    });
    expect(fs.readFileSync(dest, 'utf-8')).toBe(payload);
    expect(digest).toBe(payloadSha);
    expect(digestMatches(`sha256:${payloadSha}`, digest)).toBe(true);
  });

  it('reports progress with the advertised total', async () => {
    const dest = path.join(makeTempDir(), 'a2x');
    const seen: Array<[number, number | null]> = [];
    await downloadTo('https://example.test/a2x', dest, {
      fetchImpl: fakeFetch(payload, {
        'content-length': String(payload.length),
      }),
      onProgress: (received, total) => seen.push([received, total]),
    });
    expect(seen.at(-1)).toEqual([payload.length, payload.length]);
  });

  it('leaves no partial file behind when the server errors', async () => {
    const dest = path.join(makeTempDir(), 'a2x');
    const failing = (async () =>
      new Response('nope', {
        status: 404,
        statusText: 'Not Found',
      })) as unknown as typeof fetch;

    await expect(
      downloadTo('https://example.test/a2x', dest, { fetchImpl: failing }),
    ).rejects.toThrow(/404/);
    expect(fs.existsSync(dest)).toBe(false);
  });
});

describe('replaceExecutable', () => {
  it('swaps the staged download in for the live executable', () => {
    const dir = makeTempDir();
    const target = path.join(dir, 'a2x');
    fs.writeFileSync(target, 'old', { mode: 0o755 });

    const staged = stagedPathFor(target);
    expect(staged.startsWith(target)).toBe(true);
    fs.writeFileSync(staged, 'new', { mode: 0o755 });

    replaceExecutable(target, staged);

    expect(fs.readFileSync(target, 'utf-8')).toBe('new');
    expect(fs.existsSync(staged)).toBe(false);
  });
});

describe('fetchCliReleases', () => {
  it('sends the GitHub token when one is in the environment', async () => {
    let seen: Headers | undefined;
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return new Response('[]', { status: 200 });
    }) as unknown as typeof fetch;

    await fetchCliReleases({ fetchImpl, env: { GITHUB_TOKEN: 'tok' } });
    expect(seen?.get('authorization')).toBe('Bearer tok');
  });

  it('hints at the rate limit on an anonymous 403', async () => {
    const fetchImpl = (async () =>
      new Response('', {
        status: 403,
        statusText: 'rate limit exceeded',
      })) as unknown as typeof fetch;

    await expect(fetchCliReleases({ fetchImpl, env: {} })).rejects.toThrow(
      /rate limit/i,
    );
  });

  it('tolerates a non-array body', async () => {
    const fetchImpl = (async () =>
      new Response('{"message":"Not Found"}', {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(fetchCliReleases({ fetchImpl, env: {} })).resolves.toEqual([]);
  });
});

describe('formatBytes', () => {
  it('scales to a human-readable unit', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(61_063_360)).toBe('58.2 MiB');
  });
});
