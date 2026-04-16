import { Command } from 'commander';
import chalk from 'chalk';
import { getRegistryUrl } from '../../config.js';
import { searchAgents, type AgentSummary } from '../../api/agent-registry.js';

export const searchCommand = new Command('search')
  .description('Search for A2A agents in the agent registry')
  .argument('[query]', 'Free-text search query')
  .option('-n, --limit <number>', 'Maximum number of results', '10')
  .option('--registry <url>', 'Registry URL override')
  .option('--json', 'Output raw JSON response')
  .action(
    async (
      query: string | undefined,
      opts: { limit: string; registry?: string; json?: boolean },
    ) => {
      try {
        const registryUrl = getRegistryUrl(opts.registry);
        const limit = parseInt(opts.limit, 10);
        const results = await searchAgents(registryUrl, query, limit);

        if (opts.json) {
          console.log(JSON.stringify(results, null, 2));
          return;
        }

        if (results.length === 0) {
          if (query) {
            console.log(`No agents found matching "${query}".`);
          } else {
            console.log('No agents found in the registry.');
          }
          return;
        }

        printTable(results);
      } catch (err) {
        console.error(
          chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`),
        );
        process.exit(1);
      }
    },
  );

/**
 * Print agent search results in a formatted table.
 */
function printTable(agents: AgentSummary[]): void {
  const maxDesc = 48;

  const nameWidth = Math.max(
    'NAME'.length,
    ...agents.map((a) => a.name.length),
  );
  const descWidth = Math.max(
    'DESCRIPTION'.length,
    ...agents.map((a) => Math.min(a.description.length, maxDesc)),
  );
  const urlWidth = Math.max(
    'AGENT CARD URL'.length,
    ...agents.map((a) => a.agentCardUrl.length),
  );

  const header =
    chalk.bold('NAME'.padEnd(nameWidth)) +
    '  ' +
    chalk.bold('DESCRIPTION'.padEnd(descWidth)) +
    '  ' +
    chalk.bold('AGENT CARD URL'.padEnd(urlWidth));

  const separator =
    '-'.repeat(nameWidth) +
    '  ' +
    '-'.repeat(descWidth) +
    '  ' +
    '-'.repeat(urlWidth);

  console.log(header);
  console.log(separator);

  for (const agent of agents) {
    const desc =
      agent.description.length > maxDesc
        ? agent.description.slice(0, maxDesc - 3) + '...'
        : agent.description;

    const row =
      agent.name.padEnd(nameWidth) +
      '  ' +
      desc.padEnd(descWidth) +
      '  ' +
      agent.agentCardUrl;

    console.log(row);
  }
}
