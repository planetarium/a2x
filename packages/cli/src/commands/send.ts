import { Command } from 'commander';
import chalk from 'chalk';
import crypto from 'node:crypto';

export const sendCommand = new Command('send')
  .description('Send a message to an A2A agent')
  .argument('<url>', 'Agent JSON-RPC endpoint URL')
  .argument('<message>', 'Message text to send')
  .option('--task-id <id>', 'Continue an existing task')
  .option('--json', 'Output raw JSON response')
  .action(
    async (
      url: string,
      message: string,
      opts: { taskId?: string; json?: boolean },
    ) => {
      try {
        const requestBody = buildRequest(message, opts.taskId);

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(requestBody),
        });

        if (!res.ok) {
          console.error(
            chalk.red(
              `HTTP error: ${res.status} ${res.statusText}`,
            ),
          );
          process.exit(1);
        }

        const body = (await res.json()) as Record<string, unknown>;

        if (opts.json) {
          console.log(JSON.stringify(body, null, 2));
          return;
        }

        if (body.error) {
          printError(body.error as { code: number; message: string; data?: unknown });
          process.exit(1);
        }

        printResult(body.result as Record<string, unknown>);
      } catch (err) {
        if (
          err instanceof TypeError &&
          (err as NodeJS.ErrnoException).code === 'ECONNREFUSED'
        ) {
          console.error(chalk.red(`Connection refused: ${url}`));
        } else {
          console.error(
            chalk.red(
              `Error: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
        }
        process.exit(1);
      }
    },
  );

interface JSONRPCRequest {
  jsonrpc: '2.0';
  id: string;
  method: string;
  params: {
    message: {
      messageId: string;
      role: 'user';
      parts: Array<{ kind: 'text'; text: string }>;
      taskId?: string;
    };
  };
}

function buildRequest(message: string, taskId?: string): JSONRPCRequest {
  const msg: JSONRPCRequest['params']['message'] = {
    messageId: crypto.randomUUID(),
    role: 'user',
    parts: [{ kind: 'text', text: message }],
  };

  if (taskId) {
    msg.taskId = taskId;
  }

  return {
    jsonrpc: '2.0',
    id: crypto.randomUUID(),
    method: 'message/send',
    params: { message: msg },
  };
}

function printError(error: { code: number; message: string; data?: unknown }): void {
  console.error(chalk.red.bold('JSON-RPC Error'));
  console.error(chalk.red(`  Code:    ${error.code}`));
  console.error(chalk.red(`  Message: ${error.message}`));
  if (error.data) {
    console.error(chalk.red(`  Data:    ${JSON.stringify(error.data)}`));
  }
}

function printResult(result: Record<string, unknown>): void {
  console.log(chalk.bold.cyan('Response'));
  console.log(chalk.gray('─'.repeat(40)));

  // Task info
  if (result.id) {
    console.log(`${chalk.bold('Task ID:')}  ${result.id}`);
  }
  if (result.contextId) {
    console.log(`${chalk.bold('Context:')}  ${result.contextId}`);
  }

  // Status
  const status = result.status as Record<string, unknown> | undefined;
  if (status) {
    const state = (status.state as string) ?? 'unknown';
    const stateColor = getStateColor(state);
    console.log(`${chalk.bold('Status:')}   ${stateColor(state)}`);
  }

  // Artifacts
  const artifacts = result.artifacts as
    | Array<Record<string, unknown>>
    | undefined;
  if (artifacts?.length) {
    console.log(chalk.bold('\nArtifacts:'));
    for (const artifact of artifacts) {
      if (artifact.name) {
        console.log(`  ${chalk.yellow(artifact.name as string)}`);
      }
      const parts = artifact.parts as Array<Record<string, unknown>> | undefined;
      if (parts) {
        printParts(parts);
      }
    }
  }

  // Status message (agent response)
  if (status?.message) {
    const msg = status.message as Record<string, unknown>;
    const parts = msg.parts as Array<Record<string, unknown>> | undefined;
    if (parts?.length) {
      console.log(chalk.bold('\nAgent Message:'));
      printParts(parts);
    }
  }

  // History
  const history = result.history as Array<Record<string, unknown>> | undefined;
  if (history?.length) {
    console.log(chalk.bold('\nHistory:'));
    for (const msg of history) {
      const role = msg.role as string;
      const roleLabel = role === 'agent' ? chalk.green('Agent') : chalk.blue('User');
      console.log(`  ${roleLabel}:`);
      const parts = msg.parts as Array<Record<string, unknown>> | undefined;
      if (parts) {
        printParts(parts, '    ');
      }
    }
  }
}

function printParts(
  parts: Array<Record<string, unknown>>,
  indent = '  ',
): void {
  for (const part of parts) {
    if ('text' in part) {
      console.log(`${indent}${part.text}`);
    } else if ('data' in part) {
      console.log(`${indent}${chalk.gray(JSON.stringify(part.data))}`);
    } else if ('url' in part || 'raw' in part) {
      const label = (part.filename as string) ?? (part.url as string) ?? '[file]';
      console.log(`${indent}${chalk.underline(label)}`);
    }
  }
}

function getStateColor(state: string): (text: string) => string {
  switch (state.toLowerCase().replace('task_state_', '')) {
    case 'completed':
      return chalk.green;
    case 'working':
    case 'submitted':
      return chalk.yellow;
    case 'failed':
    case 'canceled':
    case 'rejected':
      return chalk.red;
    case 'input-required':
    case 'input_required':
    case 'auth-required':
    case 'auth_required':
      return chalk.magenta;
    default:
      return chalk.white;
  }
}
