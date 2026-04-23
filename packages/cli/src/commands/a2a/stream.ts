import { Command } from 'commander';
import chalk from 'chalk';
import crypto from 'node:crypto';
import type {
  SendMessageParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2x/sdk';
import {
  getX402PaymentRequirements,
  signX402Payment,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
} from '@a2x/sdk';
import {
  printStatusUpdate,
  printArtifactChunk,
  printConnectionError,
  createClient,
} from '../../format.js';
import { activeWalletAccount } from '../../wallet-store.js';
import {
  DEFAULT_MAX_AMOUNT_ATOMIC,
  enforceBudget,
  parseMaxAmount,
  pickAffordableRequirement,
  printPaymentRequirement,
  printX402Error,
} from '../../x402-cli.js';

type StreamEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

export const streamCommand = new Command('stream')
  .description('Send a message and stream the response via SSE')
  .argument('<url>', 'Agent base URL')
  .argument('<message>', 'Message text to send')
  .option('--context-id <id>', 'Continue an existing conversation context')
  .option('-H, --header <header...>', 'Custom headers (format: Key:Value)')
  .option('--json', 'Output raw JSON events (one per line)')
  .option(
    '--no-x402',
    'Don\'t auto-sign an x402 payment even if the agent asks for one',
  )
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

        if (!opts.json) {
          console.log(chalk.bold.cyan('Streaming response...'));
          console.log(chalk.gray('─'.repeat(40)));
        }

        // First pass: consume the stream but pause as soon as a
        // payment-required status-update arrives.
        const paymentSignal = await consumeUntilPaymentRequired(
          client.sendMessageStream(params),
          opts,
        );

        if (!paymentSignal) {
          // Stream finished without ever asking for payment — normal case.
          finish(opts);
          return;
        }

        if (opts.x402 === false) {
          if (!opts.json) {
            console.log();
            console.log(
              chalk.yellow(
                'Stream paused for x402 payment; --no-x402 was set, exiting.',
              ),
            );
          }
          process.exit(2);
        }

        const signer = activeWalletAccount();
        if (!signer) {
          if (!opts.json) {
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
          }
          process.exit(2);
        }

        // Budget check + display before signing.
        enforceBudget(paymentSignal.required, maxAmount);
        if (!opts.json) {
          console.log();
          printPaymentRequirement(paymentSignal.required, maxAmount);
        }

        const signed = await signX402Payment(paymentSignal.syntheticTask, {
          signer,
          selectRequirement: (accepts) =>
            pickAffordableRequirement(
              { x402Version: 1, accepts },
              maxAmount,
            ),
        });

        // Second pass: same content + taskId + payment metadata.
        const followupParams: SendMessageParams = {
          ...params,
          message: {
            ...params.message,
            messageId: crypto.randomUUID(),
            taskId: paymentSignal.taskId,
            contextId: paymentSignal.contextId,
            metadata: {
              ...(params.message.metadata ?? {}),
              ...signed.metadata,
            },
          },
        };

        if (!opts.json) {
          console.log(
            chalk.gray(
              `  signed ${signed.requirement.maxAmountRequired} atomic → resuming stream`,
            ),
          );
          console.log();
        }

        for await (const event of client.sendMessageStream(followupParams)) {
          renderEvent(event, opts);
        }

        finish(opts);
      } catch (err) {
        const code = printX402Error(err);
        if (code !== null) process.exit(code);
        printConnectionError(err, url);
        process.exit(1);
      }
    },
  );

/**
 * Iterate the first stream, printing events as they come in. As soon as
 * we see a TaskStatusUpdateEvent whose message carries the x402
 * payment-required status, we synthesize a minimal Task so the caller
 * can feed it to `signX402Payment` and stop consuming further events.
 *
 * Returns `undefined` when the stream ended naturally (no payment gate).
 */
async function consumeUntilPaymentRequired(
  stream: AsyncGenerator<StreamEvent>,
  opts: { json?: boolean },
): Promise<
  | {
      required: NonNullable<ReturnType<typeof getX402PaymentRequirements>>;
      syntheticTask: Task;
      taskId: string;
      contextId: string;
    }
  | undefined
> {
  for await (const event of stream) {
    if (!('status' in event)) {
      renderEvent(event, opts);
      continue;
    }

    const meta = (event.status.message?.metadata ?? {}) as Record<string, unknown>;
    const x402Status = meta[X402_METADATA_KEYS.STATUS];
    if (x402Status === X402_PAYMENT_STATUS.REQUIRED) {
      // The SDK helpers expect a Task shape, not a status-update event.
      const syntheticTask: Task = {
        id: event.taskId,
        contextId: event.contextId,
        status: event.status,
      };
      const required = getX402PaymentRequirements(syntheticTask);
      if (required) {
        // Print the status update (so the user sees the pause) and stop.
        renderEvent(event, opts);
        return {
          required,
          syntheticTask,
          taskId: event.taskId,
          contextId: event.contextId,
        };
      }
    }

    renderEvent(event, opts);
  }
  return undefined;
}

/**
 * Whether the cursor is currently mid-line after a streaming artifact chunk
 * that was written without a trailing newline.
 */
let midLine = false;

function flushLine(): void {
  if (midLine) {
    process.stdout.write('\n');
    midLine = false;
  }
}

function renderEvent(event: StreamEvent, opts: { json?: boolean }): void {
  if (opts.json) {
    console.log(JSON.stringify(event));
    return;
  }
  if ('status' in event) {
    flushLine();
    printStatusUpdate(event);
  } else {
    printArtifactChunk(event, true);
    if (event.artifact.parts.some((p) => 'text' in p)) {
      midLine = true;
    }
    if (event.lastChunk) {
      flushLine();
    }
  }
}

function finish(opts: { json?: boolean }): void {
  if (opts.json) return;
  flushLine();
  console.log(chalk.gray('─'.repeat(40)));
  console.log(chalk.green('Stream completed'));
}
