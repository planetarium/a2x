import { Command } from 'commander';
import { walletCreateCommand } from './create.js';
import { walletListCommand } from './list.js';
import { walletShowCommand } from './show.js';
import { walletUseCommand } from './use.js';
import { walletDeleteCommand } from './delete.js';
import { walletRevealKeyCommand } from './reveal-key.js';

export const walletCommand = new Command('wallet')
  .description(
    'Manage local EVM wallets used to sign x402 payments and other signed requests',
  )
  .addCommand(walletCreateCommand)
  .addCommand(walletListCommand)
  .addCommand(walletShowCommand)
  .addCommand(walletUseCommand)
  .addCommand(walletDeleteCommand)
  .addCommand(walletRevealKeyCommand);
