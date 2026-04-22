import { Command } from 'commander';
import chalk from 'chalk';
import { deleteWallet, WalletNotFoundError } from '../../wallet-store.js';

export const walletDeleteCommand = new Command('delete')
  .alias('rm')
  .description('Delete a wallet from local storage')
  .argument('<name>', 'Wallet name')
  .option('--yes', 'Skip the confirmation prompt')
  .action(async (name: string, opts: { yes?: boolean }) => {
    try {
      if (!opts.yes) {
        // Minimal prompt. Using the SDK without interactive helpers.
        process.stdout.write(
          chalk.yellow(
            `About to permanently delete wallet "${name}" and its private key. Type "yes" to confirm: `,
          ),
        );
        const answer = await new Promise<string>((resolve) => {
          process.stdin.once('data', (chunk) => resolve(chunk.toString().trim()));
          process.stdin.resume();
        });
        process.stdin.pause();
        if (answer.toLowerCase() !== 'yes') {
          console.log('Canceled.');
          return;
        }
      }
      deleteWallet(name);
      console.log(chalk.green('✓'), `Deleted wallet ${chalk.bold(name)}`);
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
