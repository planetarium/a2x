import { program } from 'commander';
import { agentCardCommand, sendCommand, streamCommand, taskCommand } from './commands/index.js';

program
  .name('a2x')
  .description('CLI for the a2x A2A protocol SDK')
  .version('0.1.0');

program.addCommand(agentCardCommand);
program.addCommand(sendCommand);
program.addCommand(streamCommand);
program.addCommand(taskCommand);

program.parse();
