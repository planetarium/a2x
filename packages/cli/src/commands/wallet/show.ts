import { Command } from 'commander';
import chalk from 'chalk';
import {
  getActiveWallet,
  getWallet,
  WalletNotFoundError,
} from '../../wallet-store.js';

export const walletShowCommand = new Command('show')
  .description('Show the active wallet, or a specific one by name')
  .argument('[name]', 'Wallet name. Defaults to the active wallet.')
  .option('--json', 'Output raw JSON')
  .action((name: string | undefined, opts: { json?: boolean }) => {
    try {
      const wallet = name ? getWallet(name) : getActiveWallet();
      if (!wallet) {
        console.error(
          chalk.red('Error:'),
          'No active wallet. Create one with `a2x wallet create` or specify a name.',
        );
        process.exit(1);
      }
      if (opts.json) {
        // Never leak the private key in normal output, even in --json.
        const { privateKey: _pk, ...rest } = wallet;
        console.log(JSON.stringify(rest, null, 2));
        return;
      }
      console.log(`${chalk.bold('Name:')}    ${wallet.name}`);
      console.log(`${chalk.bold('Address:')} ${chalk.cyan(wallet.address)}`);
      console.log(`${chalk.bold('Created:')} ${wallet.createdAt}`);
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
