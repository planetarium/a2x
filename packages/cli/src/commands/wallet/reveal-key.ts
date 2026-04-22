import { Command } from 'commander';
import chalk from 'chalk';
import {
  getActiveWallet,
  getWallet,
  WalletNotFoundError,
} from '../../wallet-store.js';

export const walletRevealKeyCommand = new Command('reveal-key')
  .description('Print a wallet private key in hex (prompts for confirmation)')
  .argument('[name]', 'Wallet name. Defaults to the active wallet.')
  .option('--yes', 'Skip the confirmation prompt')
  .action(async (name: string | undefined, opts: { yes?: boolean }) => {
    try {
      const wallet = name ? getWallet(name) : getActiveWallet();
      if (!wallet) {
        console.error(
          chalk.red('Error:'),
          'No active wallet. Specify a name or `a2x wallet use <name>` first.',
        );
        process.exit(1);
      }

      if (!opts.yes) {
        process.stdout.write(
          chalk.yellow(
            `About to print the private key for "${wallet.name}" (${wallet.address}). Anyone who sees it can steal funds.\nType "reveal" to continue: `,
          ),
        );
        const answer = await new Promise<string>((resolve) => {
          process.stdin.once('data', (chunk) => resolve(chunk.toString().trim()));
          process.stdin.resume();
        });
        process.stdin.pause();
        if (answer.toLowerCase() !== 'reveal') {
          console.log('Canceled.');
          return;
        }
      }

      console.log(wallet.privateKey);
    } catch (err) {
      if (err instanceof WalletNotFoundError) {
        console.error(chalk.red('Error:'), err.message);
        process.exit(2);
      }
      console.error(
        chalk.red('Error:'),
        err instanceof Error ? err.message : String(err),
      );
      process.exit(1);
    }
  });
