import { Command } from 'commander';
import { resolveAgentCard } from 'a2x/client';
import { printAgentCard, printConnectionError, parseHeaders } from '../format.js';

export const agentCardCommand = new Command('agent-card')
  .description('Fetch and display an A2A agent card')
  .argument('<url>', 'Agent base URL or direct agent card URL (.json)')
  .option('--json', 'Output raw JSON')
  .option('-H, --header <header...>', 'Custom headers (format: Key:Value)')
  .action(async (url: string, opts: { json?: boolean; header?: string[] }) => {
    try {
      const headers = parseHeaders(opts.header);
      const resolved = await resolveAgentCard(url, { headers });

      if (opts.json) {
        console.log(JSON.stringify(resolved.card, null, 2));
        return;
      }

      printAgentCard(
        resolved.card as unknown as Record<string, unknown>,
        resolved.version,
      );
    } catch (err) {
      printConnectionError(err, url);
      process.exit(1);
    }
  });
