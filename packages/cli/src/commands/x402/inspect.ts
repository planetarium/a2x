import { Command } from 'commander';
import chalk from 'chalk';
import crypto from 'node:crypto';
import type { SendMessageParams } from '@a2x/sdk';
import {
  getX402PaymentRequirements,
  X402_EXTENSION_URI,
} from '@a2x/sdk';
import { createClient, printConnectionError } from '../../format.js';

export const x402InspectCommand = new Command('inspect')
  .description(
    'Probe an agent for its x402 payment requirements without signing or paying',
  )
  .argument('<url>', 'Agent base URL')
  .option('-H, --header <header...>', 'Custom headers (format: Key:Value)')
  .option('--json', 'Output raw JSON')
  .action(
    async (
      url: string,
      opts: { header?: string[]; json?: boolean },
    ) => {
      try {
        const client = createClient(url, opts);

        const card = await client.getAgentCard();
        const extensions = (card as unknown as {
          capabilities?: { extensions?: { uri: string }[] };
        }).capabilities?.extensions ?? [];
        const declares = extensions.some((e) => e.uri === X402_EXTENSION_URI);

        const params: SendMessageParams = {
          message: {
            messageId: crypto.randomUUID(),
            role: 'user',
            parts: [{ text: '' }],
          },
        };

        const task = await client.sendMessage(params);
        const required = getX402PaymentRequirements(task);

        if (opts.json) {
          console.log(
            JSON.stringify(
              { declaresExtension: declares, paymentRequired: required },
              null,
              2,
            ),
          );
          return;
        }

        console.log(chalk.bold.cyan('x402 support'));
        console.log(chalk.gray('─'.repeat(40)));
        console.log(
          `${chalk.bold('AgentCard extension:')}  ${
            declares ? chalk.green('advertised') : chalk.yellow('not advertised')
          }`,
        );

        if (!required) {
          console.log(
            `${chalk.bold('Probe response:')}       ${chalk.yellow(
              'agent did not reply with payment-required',
            )}`,
          );
          console.log(
            chalk.gray(
              '\nThe agent may be free, or it may only gate certain kinds of messages.',
            ),
          );
          return;
        }

        console.log(
          `${chalk.bold('x402 version:')}         ${required.x402Version}`,
        );
        if (required.error) {
          console.log(
            `${chalk.bold('Last error:')}           ${chalk.red(required.error)}`,
          );
        }
        console.log();
        console.log(chalk.bold('Accepted payment options:'));
        for (const accept of required.accepts) {
          console.log();
          console.log(
            `  ${chalk.cyan(accept.network)} / ${accept.scheme}`,
          );
          console.log(`    amount: ${accept.maxAmountRequired}`);
          console.log(`    asset:  ${accept.asset}`);
          console.log(`    payTo:  ${accept.payTo}`);
          if (accept.description) {
            console.log(`    note:   ${accept.description}`);
          }
        }
      } catch (err) {
        printConnectionError(err, url);
        process.exit(1);
      }
    },
  );
