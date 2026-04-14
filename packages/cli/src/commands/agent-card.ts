import { Command } from 'commander';
import chalk from 'chalk';

export const agentCardCommand = new Command('agent-card')
  .description('Fetch and display an A2A agent card')
  .argument('<url>', 'Agent URL or direct agent.json URL')
  .option('--json', 'Output raw JSON')
  .option(
    '--protocol-version <version>',
    'A2A protocol version (default: auto-detect)',
  )
  .action(async (url: string, opts: { json?: boolean; protocolVersion?: string }) => {
    try {
      const cardUrl = resolveAgentCardUrl(url);
      const res = await fetch(cardUrl);

      if (!res.ok) {
        console.error(
          chalk.red(`Failed to fetch agent card: ${res.status} ${res.statusText}`),
        );
        process.exit(1);
      }

      const card = (await res.json()) as Record<string, unknown>;

      if (opts.json) {
        console.log(JSON.stringify(card, null, 2));
        return;
      }

      printAgentCard(card, opts.protocolVersion);
    } catch (err) {
      if (err instanceof TypeError && (err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
        console.error(chalk.red(`Connection refused: ${url}`));
      } else if (err instanceof SyntaxError) {
        console.error(chalk.red('Invalid JSON response from server'));
      } else {
        console.error(
          chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`),
        );
      }
      process.exit(1);
    }
  });

function resolveAgentCardUrl(url: string): string {
  if (url.endsWith('.json')) {
    return url;
  }
  const base = url.replace(/\/+$/, '');
  return `${base}/.well-known/agent.json`;
}

function printAgentCard(card: Record<string, unknown>, protocolVersion?: string): void {
  // Determine protocol version from card or option
  const version =
    protocolVersion ??
    (card.protocolVersion as string | undefined) ??
    detectProtocolVersion(card);

  console.log(chalk.bold.cyan('Agent Card'));
  console.log(chalk.gray('─'.repeat(40)));

  if (card.name) {
    console.log(`${chalk.bold('Name:')}         ${card.name}`);
  }
  if (card.description) {
    console.log(`${chalk.bold('Description:')}  ${card.description}`);
  }
  if (card.version) {
    console.log(`${chalk.bold('Version:')}      ${card.version}`);
  }
  console.log(`${chalk.bold('Protocol:')}     ${version ?? 'unknown'}`);

  // URL(s)
  if (card.url) {
    console.log(`${chalk.bold('URL:')}          ${card.url}`);
  }
  const interfaces = (card.supportedInterfaces ?? card.additionalInterfaces) as
    | Array<Record<string, string>>
    | undefined;
  if (interfaces?.length) {
    console.log(chalk.bold('\nInterfaces:'));
    for (const iface of interfaces) {
      const binding = iface.protocolBinding ?? iface.transport ?? '';
      console.log(`  ${chalk.green('•')} ${iface.url}${binding ? ` (${binding})` : ''}`);
    }
  }

  // Capabilities
  const caps = card.capabilities as Record<string, unknown> | undefined;
  if (caps) {
    console.log(chalk.bold('\nCapabilities:'));
    if (caps.streaming) console.log(`  ${chalk.green('✓')} Streaming`);
    if (caps.pushNotifications) console.log(`  ${chalk.green('✓')} Push Notifications`);
    if (caps.stateTransitionHistory) console.log(`  ${chalk.green('✓')} State Transition History`);
    if (caps.extendedAgentCard) console.log(`  ${chalk.green('✓')} Extended Agent Card`);
  }

  // Skills
  const skills = card.skills as Array<Record<string, unknown>> | undefined;
  if (skills?.length) {
    console.log(chalk.bold('\nSkills:'));
    for (const skill of skills) {
      console.log(`  ${chalk.yellow(skill.name ?? skill.id)}`);
      if (skill.description) {
        console.log(`    ${chalk.gray(skill.description)}`);
      }
      const tags = skill.tags as string[] | undefined;
      if (tags?.length) {
        console.log(`    Tags: ${tags.map((t) => chalk.blue(t)).join(', ')}`);
      }
    }
  }

  // Provider
  const provider = card.provider as Record<string, string> | undefined;
  if (provider) {
    console.log(chalk.bold('\nProvider:'));
    console.log(`  ${provider.organization}${provider.url ? ` (${provider.url})` : ''}`);
  }
}

function detectProtocolVersion(card: Record<string, unknown>): string | undefined {
  if ('protocolVersion' in card) return card.protocolVersion as string;
  if ('supportedInterfaces' in card) return '1.0';
  if ('url' in card && 'skills' in card) return '0.3';
  return undefined;
}
