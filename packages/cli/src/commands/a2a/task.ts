import { Command } from 'commander';
import { printTask, printConnectionError, createClient } from '../../format.js';

export const taskCommand = new Command('task')
  .description('Manage A2A tasks');

// ─── task get ───

taskCommand
  .command('get')
  .description('Get the current state of a task')
  .argument('<url>', 'Agent base URL')
  .argument('<task-id>', 'Task ID to retrieve')
  .option('-H, --header <header...>', 'Custom headers (format: Key:Value)')
  .option('--json', 'Output raw JSON response')
  .action(
    async (
      url: string,
      taskId: string,
      opts: { header?: string[]; json?: boolean },
    ) => {
      try {
        const client = createClient(url, opts);
        const task = await client.getTask(taskId);

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

// ─── task cancel ───

taskCommand
  .command('cancel')
  .description('Request cancellation of a task')
  .argument('<url>', 'Agent base URL')
  .argument('<task-id>', 'Task ID to cancel')
  .option('-H, --header <header...>', 'Custom headers (format: Key:Value)')
  .option('--json', 'Output raw JSON response')
  .action(
    async (
      url: string,
      taskId: string,
      opts: { header?: string[]; json?: boolean },
    ) => {
      try {
        const client = createClient(url, opts);
        const task = await client.cancelTask(taskId);

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
