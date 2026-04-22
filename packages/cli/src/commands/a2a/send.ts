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

/**
 * Default spend ceiling, in the asset's atomic units, applied to every
 * auto-signed x402 payment. 10_000 on a 6-decimal stablecoin is 0.01 USDC.
 *
 * Anything the server asks for above this will be refused up-front,
 * before we sign — a paranoid default for a CLI that holds real keys.
 * Override explicitly with --max-amount.
 */
const DEFAULT_MAX_AMOUNT_ATOMIC = 10_000n;

/**
 * Thrown by our onPaymentRequired callback when every payment option the
 * server advertises exceeds the configured budget. Extending Error lets
 * the outer catch recognise it and print a dedicated message without
 * falling back to the generic connection-error handler.
 */
class X402BudgetExceededError extends Error {
  constructor(
    public readonly cheapest: bigint,
    public readonly budget: bigint,
    public readonly asset: string,
  ) {
    super(
      `Refusing to pay: cheapest advertised amount ${cheapest.toString()} (atomic of ${asset}) exceeds --max-amount budget ${budget.toString()}.`,
    );
    this.name = 'X402BudgetExceededError';
  }
}

export const sendCommand = new Command('send')
  .description('Send a message to an A2A agent (blocking)')
  .argument('<url>', 'Agent base URL')
  .argument('<message>', 'Message text to send')
  .option('--context-id <id>', 'Continue an existing conversation context')
  .option('-H, --header <header...>', 'Custom headers (format: Key:Value)')
  .option('--json', 'Output raw JSON response')
  .option('--no-x402', 'Don\'t auto-sign an x402 payment even if the agent asks for one')
  .option(
    '--max-amount <atomic>',
    'Maximum amount (in asset\'s atomic units) to auto-sign for an x402 payment. ' +
      `Defaults to ${DEFAULT_MAX_AMOUNT_ATOMIC.toString()}.`,
  )
  .action(
    async (
      url: string,
      message: string,
      opts: {
        contextId?: string;
        header?: string[];
        json?: boolean;
        x402?: boolean;
        maxAmount?: string;
      },
    ) => {
      const maxAmount = parseMaxAmount(opts.maxAmount);

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
            printPaymentRequirement(required, maxAmount);
          }

          const x402 = new X402Client(client, {
            signer,
            // Budget guard: refuse up-front if every option the server
            // advertised exceeds our ceiling. Throwing here aborts the
            // flow before createPaymentHeader signs anything.
            onPaymentRequired: (r) => {
              const affordable = r.accepts.filter(
                (a) => safeBigInt(a.maxAmountRequired) <= maxAmount,
              );
              if (affordable.length === 0) {
                const cheapest = r.accepts
                  .map((a) => ({
                    v: safeBigInt(a.maxAmountRequired),
                    asset: a.asset,
                  }))
                  .sort((x, y) => (x.v < y.v ? -1 : 1))[0];
                throw new X402BudgetExceededError(
                  cheapest?.v ?? 0n,
                  maxAmount,
                  cheapest?.asset ?? 'unknown',
                );
              }
            },
            // Prefer the cheapest requirement that fits the budget and
            // uses the "exact" scheme. Falls back to anything affordable.
            selectRequirement: (accepts) => {
              const affordable = accepts
                .filter((a) => safeBigInt(a.maxAmountRequired) <= maxAmount)
                .sort((x, y) =>
                  safeBigInt(x.maxAmountRequired) <
                  safeBigInt(y.maxAmountRequired)
                    ? -1
                    : 1,
                );
              return (
                affordable.find((a) => a.scheme === 'exact') ?? affordable[0]
              );
            },
          });
          task = await x402.sendMessage(params);
        }

        if (opts.json) {
          console.log(JSON.stringify(task, null, 2));
          return;
        }

        printTask(task);
        printReceiptsFromTask(task);
      } catch (err) {
        if (err instanceof X402BudgetExceededError) {
          console.error();
          console.error(
            chalk.red('✗'),
            chalk.bold.red('x402 payment refused (over budget)'),
          );
          console.error(`  cheapest option: ${err.cheapest.toString()} atomic of ${err.asset}`);
          console.error(`  --max-amount:    ${err.budget.toString()}`);
          console.error(
            chalk.yellow(
              '\n  Raise the ceiling with `--max-amount <atomic>` if you trust the merchant.',
            ),
          );
          process.exit(2);
        }
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

function parseMaxAmount(raw: string | undefined): bigint {
  if (raw === undefined) return DEFAULT_MAX_AMOUNT_ATOMIC;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `--max-amount must be a non-negative integer in atomic units; got "${raw}".`,
    );
  }
  return BigInt(raw);
}

function safeBigInt(raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    // An invalid amount string should not let a payment through.
    // Return a value that always trips the ">= budget" check.
    return 2n ** 256n;
  }
}

function printPaymentRequirement(
  required: X402PaymentRequiredResponse,
  budget: bigint,
): void {
  console.log(chalk.bold.magenta('x402: payment required'));
  console.log(chalk.gray('─'.repeat(40)));
  for (const accept of required.accepts) {
    printAccept(accept, budget);
  }
  console.log(
    chalk.gray(`  (budget: ${budget.toString()} atomic — use --max-amount to change)`),
  );
  console.log();
}

function printAccept(accept: X402PaymentRequirements, budget: bigint): void {
  const amount = accept.maxAmountRequired;
  const overBudget = safeBigInt(amount) > budget;
  const amountLine = overBudget
    ? chalk.red(`${amount} (over budget)`)
    : amount;
  console.log(
    `  ${chalk.bold('network:')}  ${chalk.cyan(accept.network)}`,
  );
  console.log(`  ${chalk.bold('scheme:')}   ${accept.scheme}`);
  console.log(`  ${chalk.bold('amount:')}   ${amountLine} (atomic units of ${accept.asset.slice(0, 10)}…)`);
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
