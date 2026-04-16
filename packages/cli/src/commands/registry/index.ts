import { Command } from 'commander';
import { searchCommand } from './search.js';
import { registerCommand } from './register.js';

export const registryCommand = new Command('registry')
  .description('Agent Registry commands');

registryCommand.addCommand(searchCommand);
registryCommand.addCommand(registerCommand);
