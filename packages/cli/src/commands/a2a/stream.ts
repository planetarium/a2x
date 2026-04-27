import { Command } from 'commander';
import chalk from 'chalk';
import crypto from 'node:crypto';
import type {
  SendMessageParams,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
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
  buildBudgetedX402ClientSettings,
  parseMaxAmount,
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
      const noX402 = opts.x402 === false;
      const signer = noX402 ? undefined : activeWalletAccount();

      if (!noX402 && !signer && !opts.json) {
        console.log(
          chalk.gray(
            '(no active wallet — paid agents will return payment-required without auto-signing)',
          ),
        );
      }

      try {
        const client = createClient(url, opts, {
          x402: signer
            ? buildBudgetedX402ClientSettings({ signer, maxAmount })
            : undefined,
        });

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

        for await (const event of client.sendMessageStream(params)) {
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
