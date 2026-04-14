import { Command } from 'commander';
import crypto from 'node:crypto';
import type { SendMessageParams } from 'a2x';
import { printTask, printConnectionError, createClient } from '../../format.js';

export const sendCommand = new Command('send')
  .description('Send a message to an A2A agent (blocking)')
  .argument('<url>', 'Agent base URL')
  .argument('<message>', 'Message text to send')
  .option('--context-id <id>', 'Continue an existing conversation context')
  .option('-H, --header <header...>', 'Custom headers (format: Key:Value)')
  .option('--json', 'Output raw JSON response')
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

        const task = await client.sendMessage(params);

        if (opts.json) {
          console.log(JSON.stringify(task, null, 2));
          return;
        }

        printTask(task);
      } catch (err) {
        printConnectionError(err, url);
        process.exit(1);
      }
    },
  );
