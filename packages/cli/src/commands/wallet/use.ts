import { Command } from 'commander';
import chalk from 'chalk';
import { useWallet, WalletNotFoundError } from '../../wallet-store.js';

export const walletUseCommand = new Command('use')
  .description('Set the active wallet used by CLI commands that need a signer')
  .argument('<name>', 'Wallet name')
  .action((name: string) => {
    try {
      const wallet = useWallet(name);
      console.log(
        chalk.green('✓'),
        `Active wallet set to ${chalk.bold(wallet.name)} (${chalk.cyan(wallet.address)})`,
      );
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
