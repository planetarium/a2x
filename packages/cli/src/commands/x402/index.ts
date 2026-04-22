import { Command } from 'commander';
import { x402InspectCommand } from './inspect.js';

export const x402Command = new Command('x402')
  .description('Inspect and interact with x402 payment-gated A2A agents')
  .addCommand(x402InspectCommand);
