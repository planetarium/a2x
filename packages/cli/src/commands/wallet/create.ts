import { Command } from 'commander';
import chalk from 'chalk';
import {
  createWallet,
  WalletAlreadyExistsError,
} from '../../wallet-store.js';

export const walletCreateCommand = new Command('create')
  .description('Create a new wallet (generates a fresh private key, or imports one)')
  .argument('[name]', 'Wallet name. Defaults to "default".', 'default')
  .option('--import <privateKey>', 'Import an existing 32-byte hex private key')
  .option('--make-active', 'Set this wallet as active even if another is already active')
  .action(
    async (
      name: string,
      opts: { import?: string; makeActive?: boolean },
    ) => {
      try {
        const wallet = createWallet(name, {
          privateKey: opts.import,
          makeActive: opts.makeActive,
        });
        console.log(chalk.green('✓'), `Created wallet ${chalk.bold(wallet.name)}`);
        console.log(`  Address: ${chalk.cyan(wallet.address)}`);
        if (!opts.import) {
          console.log(
            chalk.yellow(
              '\n  The private key is stored unencrypted at ~/.a2x/wallets/' +
                wallet.name +
                '.json (mode 0600).',
            ),
          );
          console.log(
            chalk.yellow(
              '  For real funds, export it and move to a hardware wallet or KMS.',
            ),
          );
        }
      } catch (err) {
        if (err instanceof WalletAlreadyExistsError) {
          console.error(chalk.red('Error:'), err.message);
          process.exit(2);
        }
        console.error(
          chalk.red('Error:'),
          err instanceof Error ? err.message : String(err),
        );
        process.exit(1);
      }
    },
  );
