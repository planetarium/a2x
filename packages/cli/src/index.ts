import { program } from 'commander';
import { a2aCommand, registryCommand } from './commands/index.js';

declare const __CLI_VERSION__: string;

program
  .name('a2x')
  .description('CLI for the a2x A2A protocol SDK')
  .version(__CLI_VERSION__);

program.addCommand(a2aCommand);
program.addCommand(registryCommand);

program.parse();
