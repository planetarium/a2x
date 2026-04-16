import { Command } from 'commander';
import chalk from 'chalk';
import crypto from 'node:crypto';
import type { SendMessageParams } from '@a2x/a2x';
import { printStatusUpdate, printArtifactChunk, printConnectionError, createClient } from '../../format.js';

export const streamCommand = new Command('stream')
  .description('Send a message and stream the response via SSE')
  .argument('<url>', 'Agent base URL')
  .argument('<message>', 'Message text to send')
  .option('--context-id <id>', 'Continue an existing conversation context')
  .option('-H, --header <header...>', 'Custom headers (format: Key:Value)')
  .option('--json', 'Output raw JSON events (one per line)')
  .action(
    async (
      url: string,
      message: string,
      opts: { contextId?: string; header?: string[]; json?: boolean },
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

        if (!opts.json) {
          console.log(chalk.bold.cyan('Streaming response...'));
          console.log(chalk.gray('─'.repeat(40)));
        }

        const stream = client.sendMessageStream(params);

        for await (const event of stream) {
          if (opts.json) {
            console.log(JSON.stringify(event));
            continue;
          }

          if ('status' in event) {
            printStatusUpdate(event);
          } else {
            printArtifactChunk(event, true);
          }
        }

        if (!opts.json) {
          process.stdout.write('\n');
          console.log(chalk.gray('─'.repeat(40)));
          console.log(chalk.green('Stream completed'));
        }
      } catch (err) {
        printConnectionError(err, url);
        process.exit(1);
      }
    },
  );
