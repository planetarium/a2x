/**
 * Shared formatting and utility functions for CLI output.
 */

import chalk from 'chalk';
import { A2XClient, resolveAgentCard, BearerTokenAuthProvider, createAuthFromAgentCard } from 'a2x/client';
import type { Task, TaskStatusUpdateEvent, TaskArtifactUpdateEvent, Part } from 'a2x';

// ─── Error Formatting ───

export function printError(error: { code: number; message: string; data?: unknown }): void {
  console.error(chalk.red.bold('JSON-RPC Error'));
  console.error(chalk.red(`  Code:    ${error.code}`));
  console.error(chalk.red(`  Message: ${error.message}`));
  if (error.data) {
    console.error(chalk.red(`  Data:    ${JSON.stringify(error.data)}`));
  }
}

export function printConnectionError(err: unknown, url: string): void {
  if (err instanceof TypeError && (err as NodeJS.ErrnoException).code === 'ECONNREFUSED') {
    console.error(chalk.red(`Connection refused: ${url}`));
  } else {
    console.error(
      chalk.red(`Error: ${err instanceof Error ? err.message : String(err)}`),
    );
  }
}

// ─── Task Formatting ───

export function printTask(task: Task): void {
  console.log(chalk.bold.cyan('Response'));
  console.log(chalk.gray('─'.repeat(40)));

  if (task.id) {
    console.log(`${chalk.bold('Task ID:')}  ${task.id}`);
  }
  if (task.contextId) {
    console.log(`${chalk.bold('Context:')}  ${task.contextId}`);
  }

  if (task.status) {
    const state = task.status.state;
    const stateColor = getStateColor(state);
    console.log(`${chalk.bold('Status:')}   ${stateColor(state)}`);
  }

  if (task.artifacts?.length) {
    console.log(chalk.bold('\nArtifacts:'));
    for (const artifact of task.artifacts) {
      if (artifact.name) {
        console.log(`  ${chalk.yellow(artifact.name)}`);
      }
      printParts(artifact.parts);
    }
  }

  if (task.status?.message) {
    const msg = task.status.message;
    if (msg.parts?.length) {
      console.log(chalk.bold('\nAgent Message:'));
      printParts(msg.parts);
    }
  }

  if (task.history?.length) {
    console.log(chalk.bold('\nHistory:'));
    for (const msg of task.history) {
      const roleLabel = msg.role === 'agent' ? chalk.green('Agent') : chalk.blue('User');
      console.log(`  ${roleLabel}:`);
      printParts(msg.parts, '    ');
    }
  }
}

// ─── Streaming Event Formatting ───

export function printStatusUpdate(event: TaskStatusUpdateEvent): void {
  const state = event.status.state;
  const stateColor = getStateColor(state);
  process.stdout.write(
    chalk.gray(`[${event.taskId}] `) + chalk.bold('Status: ') + stateColor(state) + '\n',
  );

  if (event.status.message?.parts?.length) {
    for (const part of event.status.message.parts) {
      if ('text' in part) {
        process.stdout.write(chalk.gray(`  ${part.text}\n`));
      }
    }
  }
}

export function printArtifactChunk(event: TaskArtifactUpdateEvent, streaming = true): void {
  for (const part of event.artifact.parts) {
    if ('text' in part) {
      if (streaming) {
        process.stdout.write(part.text);
      } else {
        console.log(`  ${part.text}`);
      }
    } else if ('data' in part) {
      console.log(chalk.gray(JSON.stringify(part.data)));
    } else if ('url' in part || 'raw' in part) {
      const label = ('filename' in part ? part.filename : undefined) ??
        ('url' in part ? part.url : undefined) ?? '[file]';
      console.log(chalk.underline(label));
    }
  }
}

// ─── Part Formatting ───

export function printParts(
  parts: Part[] | Array<Record<string, unknown>>,
  indent = '  ',
): void {
  for (const part of parts) {
    if ('text' in part) {
      console.log(`${indent}${part.text}`);
    } else if ('data' in part) {
      console.log(`${indent}${chalk.gray(JSON.stringify(part.data))}`);
    } else if ('url' in part || 'raw' in part) {
      const p = part as Record<string, unknown>;
      const label = (p.filename as string) ?? (p.url as string) ?? '[file]';
      console.log(`${indent}${chalk.underline(label)}`);
    }
  }
}

// ─── Agent Card Formatting ───

export function printAgentCard(card: Record<string, unknown>, version?: string): void {
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

  // Security
  const secSchemes = card.securitySchemes as Record<string, unknown> | undefined;
  if (secSchemes && Object.keys(secSchemes).length > 0) {
    console.log(chalk.bold('\nSecurity Schemes:'));
    for (const [name, scheme] of Object.entries(secSchemes)) {
      const s = scheme as Record<string, unknown>;
      const type = s.type ?? s.scheme ?? 'unknown';
      console.log(`  ${chalk.green('•')} ${name} (${type})`);
    }
  }

  // Provider
  const provider = card.provider as Record<string, string> | undefined;
  if (provider) {
    console.log(chalk.bold('\nProvider:'));
    console.log(`  ${provider.organization}${provider.url ? ` (${provider.url})` : ''}`);
  }
}

// ─── Helpers ───

export function getStateColor(state: string): (text: string) => string {
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

// ─── CLI Shared Utilities ───

export function parseHeaders(headerArgs?: string[]): Record<string, string> | undefined {
  if (!headerArgs?.length) return undefined;
  const headers: Record<string, string> = {};
  for (const h of headerArgs) {
    const idx = h.indexOf(':');
    if (idx > 0) {
      headers[h.slice(0, idx).trim()] = h.slice(idx + 1).trim();
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Create an A2XClient from CLI arguments.
 *
 * When `--api-key` is provided, fetches the AgentCard first to discover
 * the correct header name from the security scheme declaration.
 * When `--token` is provided, injects `Authorization: Bearer <token>` directly.
 */
export async function createClient(
  url: string,
  opts: { header?: string[]; apiKey?: string; token?: string },
): Promise<A2XClient> {
  const headers = parseHeaders(opts.header);

  // Bearer token — no AgentCard fetch needed
  if (opts.token) {
    return new A2XClient(url, {
      headers,
      auth: new BearerTokenAuthProvider({ token: opts.token }),
    });
  }

  // API Key — fetch AgentCard to discover header name
  if (opts.apiKey) {
    const resolved = await resolveAgentCard(url, { headers });
    const auth = createAuthFromAgentCard(resolved.card, { apiKey: opts.apiKey });
    return new A2XClient(resolved.card, { headers, auth });
  }

  return new A2XClient(url, { headers });
}
