import { program } from 'commander';
import {
  a2aCommand,
  registryCommand,
  updateCommand,
  walletCommand,
  x402Command,
} from './commands/index.js';
import { CLI_VERSION } from './version.js';

program
  .name('a2x')
  .description('CLI for the a2x A2A protocol SDK')
  .version(CLI_VERSION);

program.addCommand(a2aCommand);
program.addCommand(registryCommand);
program.addCommand(walletCommand);
program.addCommand(x402Command);
program.addCommand(updateCommand);

program.parse();
