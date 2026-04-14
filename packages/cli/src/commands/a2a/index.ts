import { Command } from 'commander';
import { agentCardCommand } from './agent-card.js';
import { sendCommand } from './send.js';
import { streamCommand } from './stream.js';
import { taskCommand } from './task.js';

export const a2aCommand = new Command('a2a')
  .description('A2A protocol commands');

a2aCommand.addCommand(agentCardCommand);
a2aCommand.addCommand(sendCommand);
a2aCommand.addCommand(streamCommand);
a2aCommand.addCommand(taskCommand);
