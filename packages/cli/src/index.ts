import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { program } from 'commander';
import { a2aCommand, registryCommand } from './commands/index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8'));

program
  .name('a2x')
  .description('CLI for the a2x A2A protocol SDK')
  .version(pkg.version);

program.addCommand(a2aCommand);
program.addCommand(registryCommand);

program.parse();
