import { Command } from 'commander';
import chalk from 'chalk';
import crypto from 'node:crypto';
import type { SendMessageParams, Task } from '@a2x/sdk';
import {
  X402Client,
  X402PaymentFailedError,
  getX402PaymentRequirements,
  getX402Receipts,
  type X402PaymentRequiredResponse,
  type X402PaymentRequirements,
} from '@a2x/sdk';
import { printTask, printConnectionError, createClient } from '../../format.js';
import { activeWalletAccount } from '../../wallet-store.js';

export const sendCommand = new Command('send')
  .description('Send a message to an A2A agent (blocking)')
  .argument('<url>', 'Agent base URL')
  .argument('<message>', 'Message text to send')
  .option('--context-id <id>', 'Continue an existing conversation context')
  .option('-H, --header <header...>', 'Custom headers (format: Key:Value)')
  .option('--json', 'Output raw JSON response')
  .option('--no-x402', 'Don\'t auto-sign an x402 payment even if the agent asks for one')
  .action(
    async (
      url: string,
      message: string,
      opts: {
        contextId?: string;
        header?: string[];
        json?: boolean;
        x402?: boolean;
      },
    ) => {
      try {
        const client = createClient(url, opts);

        const params: SendMessageParams = {
          message: {
            messageId: crypto.randomUUID(),
            role: 'user',
            parts: [{ text: message }],
          },
        };

        if (opts.contextId) {
          params.message.contextId = opts.contextId;
        }

        let task: Task = await client.sendMessage(params);

        // Handle x402 payment-required — unless the user opted out via --no-x402.
        // commander maps --no-x402 to opts.x402 === false.
        const required = getX402PaymentRequirements(task);
        if (required && opts.x402 !== false) {
          const signer = activeWalletAccount();
          if (!signer) {
            if (opts.json) {
              console.log(JSON.stringify(task, null, 2));
              return;
            }
            printTask(task);
            console.log();
            console.error(
              chalk.yellow(
                'Agent is asking for an x402 payment but no wallet is active.',
              ),
            );
            console.error(
              chalk.yellow(
                'Run `a2x wallet create` (or `a2x wallet use <name>`) to unlock paid calls.',
              ),
            );
            process.exit(2);
          }

          if (!opts.json) {
            printPaymentRequirement(required);
          }

          const x402 = new X402Client(client, { signer });
          task = await x402.sendMessage(params);
        }

        if (opts.json) {
          console.log(JSON.stringify(task, null, 2));
          return;
        }

        printTask(task);
        printReceiptsFromTask(task);
      } catch (err) {
        if (err instanceof X402PaymentFailedError) {
          console.error();
          console.error(
            chalk.red('✗'),
            chalk.bold.red('x402 payment failed'),
            chalk.gray(`(${err.code})`),
          );
          console.error(`  ${err.message}`);
          if (err.transaction) {
            console.error(`  tx: ${err.transaction} (${err.network ?? 'unknown'})`);
          }
          process.exit(2);
        }
        printConnectionError(err, url);
        process.exit(1);
      }
    },
  );

function printPaymentRequirement(required: X402PaymentRequiredResponse): void {
  console.log(chalk.bold.magenta('x402: payment required'));
  console.log(chalk.gray('─'.repeat(40)));
  for (const accept of required.accepts) {
    printAccept(accept);
  }
  console.log();
}

function printAccept(accept: X402PaymentRequirements): void {
  const amount = accept.maxAmountRequired;
  console.log(
    `  ${chalk.bold('network:')}  ${chalk.cyan(accept.network)}`,
  );
  console.log(`  ${chalk.bold('scheme:')}   ${accept.scheme}`);
  console.log(`  ${chalk.bold('amount:')}   ${amount} (atomic units of ${accept.asset.slice(0, 10)}…)`);
  console.log(`  ${chalk.bold('pay to:')}   ${accept.payTo}`);
  if (accept.description) {
    console.log(`  ${chalk.bold('note:')}     ${accept.description}`);
  }
}

function printReceiptsFromTask(task: Task): void {
  const receipts = getX402Receipts(task);
  if (receipts.length === 0) return;
  console.log();
  console.log(chalk.bold.magenta('x402: payment receipts'));
  for (const receipt of receipts) {
    const status = receipt.success
      ? chalk.green('✓ settled')
      : chalk.red(`✗ ${receipt.errorReason ?? 'failed'}`);
    console.log(
      `  ${status}  tx: ${chalk.cyan(receipt.transaction || '(none)')}  (${receipt.network})`,
    );
  }
}
