import { Command } from 'commander';
import chalk from 'chalk';
import { getRegistryUrl } from '../../config.js';
import { registerAgent } from '../../api/agent-registry.js';

export const registerCommand = new Command('register')
  .description('Register an A2A agent in the agent registry')
  .argument('<agent-card-url>', 'URL pointing to the agent\'s Agent Card JSON')
  .option('--registry <url>', 'Registry URL override')
  .option('--json', 'Output raw JSON response')
  .action(
    async (
      agentCardUrl: string,
      opts: { registry?: string; json?: boolean },
    ) => {
      try {
        const registryUrl = getRegistryUrl(opts.registry);
        const result = await registerAgent(registryUrl, agentCardUrl);

        if (opts.json) {
          console.log(JSON.stringify(result, null, 2));
          return;
        }

        console.log(chalk.green('Agent registered successfully.'));
      } catch (err) {
        console.error(
          chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`),
        );
        process.exit(1);
      }
    },
  );
