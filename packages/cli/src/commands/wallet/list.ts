import { Command } from 'commander';
import chalk from 'chalk';
import { listWallets } from '../../wallet-store.js';

export const walletListCommand = new Command('list')
  .alias('ls')
  .description('List local wallets')
  .option('--json', 'Output raw JSON')
  .action((opts: { json?: boolean }) => {
    const wallets = listWallets();

    if (opts.json) {
      console.log(JSON.stringify(wallets, null, 2));
      return;
    }

    if (wallets.length === 0) {
      console.log(
        chalk.gray(
          'No wallets yet. Create one with `a2x wallet create [name]`.',
        ),
      );
      return;
    }

    for (const wallet of wallets) {
      const marker = wallet.active ? chalk.green('●') : ' ';
      const name = wallet.active
        ? chalk.bold(wallet.name)
        : wallet.name;
      console.log(`${marker} ${name.padEnd(20)} ${chalk.cyan(wallet.address)}`);
    }
  });
