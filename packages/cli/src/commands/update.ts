import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { Command } from 'commander';
import chalk from 'chalk';
import { CLI_VERSION } from '../version.js';
import {
  RELEASES_PAGE_URL,
  assertWritable,
  assetNameFor,
  cleanupStaleBackups,
  compareSemver,
  detectInstall,
  digestMatches,
  downloadTo,
  fetchCliReleases,
  findAsset,
  findTarballAsset,
  formatBytes,
  pickLatestCliRelease,
  replaceExecutable,
  stagedPathFor,
  type GitHubRelease,
} from '../updater.js';

interface UpdateOptions {
  check?: boolean;
  force?: boolean;
}

export const updateCommand = new Command('update')
  .description('Update the a2x CLI to the latest release')
  .option('--check', 'Only report whether a newer release exists')
  .option('--force', 'Reinstall even when already on the latest version')
  .action(async (opts: UpdateOptions) => {
    try {
      await runUpdate(opts);
    } catch (err) {
      console.error(
        chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`),
      );
      process.exitCode = 1;
    }
  });

async function runUpdate(opts: UpdateOptions): Promise<void> {
  console.log(`${chalk.bold('Current version:')} ${CLI_VERSION}`);
  console.log(chalk.gray('Checking for updates…'));

  const latest = pickLatestCliRelease(await fetchCliReleases());
  if (!latest) {
    throw new Error(
      `No published CLI release found. See ${RELEASES_PAGE_URL}.`,
    );
  }

  const { release, version } = latest;
  const comparison = compareSemver(version, CLI_VERSION);

  if (comparison < 0) {
    console.log(
      chalk.yellow(
        `Latest release is ${version}; this build (${CLI_VERSION}) is newer.`,
      ),
    );
    if (!opts.force) return;
  } else if (comparison === 0) {
    console.log(chalk.green(`a2x ${CLI_VERSION} is up to date.`));
    if (!opts.force) return;
  } else {
    console.log(
      `${chalk.bold('Update available:')} ${CLI_VERSION} ${chalk.gray('→')} ${chalk.green(version)}`,
    );
  }

  if (release.html_url) {
    console.log(chalk.gray(`Release notes: ${release.html_url}`));
  }

  if (opts.check) return;

  const install = detectInstall();
  switch (install.kind) {
    case 'binary':
      await updateBinary(release, version, install.execPath);
      return;
    case 'npm-global':
      updateNpmGlobal(release, version);
      return;
    case 'source':
      printSourceInstructions(version);
      return;
  }
}

async function updateBinary(
  release: GitHubRelease,
  version: string,
  execPath: string,
): Promise<void> {
  const assetName = assetNameFor();
  if (!assetName) {
    throw new Error(
      `No prebuilt binary for ${process.platform}/${process.arch}. ` +
        `Build from source or see ${RELEASES_PAGE_URL}.`,
    );
  }

  const asset = findAsset(release, assetName);
  if (!asset) {
    throw new Error(
      `Release ${version} has no ${assetName} asset. See ${RELEASES_PAGE_URL}.`,
    );
  }

  assertWritable(execPath);
  cleanupStaleBackups(execPath);

  const staged = stagedPathFor(execPath);
  fs.rmSync(staged, { force: true });

  console.log(
    `${chalk.bold('Downloading')} ${assetName}` +
      (asset.size ? chalk.gray(` (${formatBytes(asset.size)})`) : ''),
  );

  const progress = createProgressReporter();
  const sha256 = await downloadTo(asset.browser_download_url, staged, {
    onProgress: progress.report,
  });
  progress.finish();

  if (!digestMatches(asset.digest, sha256)) {
    fs.rmSync(staged, { force: true });
    throw new Error(
      `Checksum mismatch for ${assetName} — refusing to install. ` +
        `Expected ${asset.digest}, got sha256:${sha256}.`,
    );
  }

  try {
    fs.chmodSync(staged, 0o755);
    replaceExecutable(execPath, staged);
  } catch (err) {
    fs.rmSync(staged, { force: true });
    throw err;
  }

  console.log(chalk.green(`Updated to a2x ${version} (${execPath}).`));
}

function updateNpmGlobal(release: GitHubRelease, version: string): void {
  const tarball = findTarballAsset(release);
  if (!tarball) {
    throw new Error(
      `Release ${version} has no npm tarball asset. See ${RELEASES_PAGE_URL}.`,
    );
  }

  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const args = ['install', '-g', tarball.browser_download_url];
  console.log(chalk.gray(`$ ${npm} ${args.join(' ')}`));

  const result = spawnSync(npm, args, { stdio: 'inherit' });
  if (result.error) {
    throw new Error(`Failed to run ${npm}: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(`${npm} install exited with code ${result.status}`);
  }

  console.log(chalk.green(`Updated to a2x ${version}.`));
}

function printSourceInstructions(version: string): void {
  console.log(
    chalk.yellow(
      'This a2x runs from a source checkout, so it cannot update itself.',
    ),
  );
  console.log(`Pull ${chalk.bold(`cli-v${version}`)} and reinstall:`);
  console.log(chalk.gray('  git pull'));
  console.log(chalk.gray('  pnpm install && pnpm build'));
  console.log(chalk.gray('  pnpm cli:install'));
}

interface ProgressReporter {
  report?: (received: number, total: number | null) => void;
  finish: () => void;
}

/**
 * Render download progress on a single stderr line. Non-TTY output (CI, pipes)
 * gets nothing rather than thousands of partial-progress lines.
 */
function createProgressReporter(): ProgressReporter {
  if (!process.stderr.isTTY) return { finish: () => {} };

  let rendered = false;
  let lastRender = 0;
  return {
    report(received, total) {
      // Throttled by byte count rather than elapsed time: 512 KiB steps keep
      // the line smooth on both fast and slow links without consulting a clock.
      const done = total !== null && received >= total;
      if (!done && received - lastRender < 512 * 1024) return;
      lastRender = received;
      rendered = true;
      const label = total
        ? `${formatBytes(received)} / ${formatBytes(total)} ` +
          `(${Math.floor((received / total) * 100)}%)`
        : formatBytes(received);
      process.stderr.write(`\r  ${label}   `);
    },
    finish() {
      if (rendered) process.stderr.write('\n');
    },
  };
}
