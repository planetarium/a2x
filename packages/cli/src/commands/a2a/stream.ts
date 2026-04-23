import { Command } from 'commander';
import chalk from 'chalk';
import crypto from 'node:crypto';
import type {
  Artifact,
  EmbeddedX402Challenge,
  SendMessageParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
  X402PaymentRequiredResponse,
  X402PaymentRequirements,
} from '@a2x/sdk';
import {
  getEmbeddedX402Challenges,
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
  confirmEmbeddedPayment,
  DEFAULT_MAX_AMOUNT_ATOMIC,
  enforceBudget,
  isEmbeddedChallengeArtifact,
  parseEmbeddedPolicy,
  parseMaxAmount,
  pickAffordableRequirement,
  pickCheapestExact,
  printPaymentRequirement,
  printX402Error,
  type EmbeddedPolicy,
} from '../../x402-cli.js';

type StreamEvent = TaskStatusUpdateEvent | TaskArtifactUpdateEvent;

/** Hard cap on how many payment hops we will handle in one call. */
const MAX_PAYMENT_HOPS = 8;

/**
 * A challenge the CLI needs to sign and resubmit before the stream
 * can continue. Either Standalone (gate, from status metadata) or
 * Embedded (from a task artifact).
 */
interface PaymentSignal {
  kind: 'standalone' | 'embedded';
  required: X402PaymentRequiredResponse;
  embedded?: EmbeddedX402Challenge;
  syntheticTask: Task;
  taskId: string;
  contextId: string;
}

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
    'Maximum amount (in atomic units) to auto-sign for the Standalone gate. ' +
      `Defaults to ${DEFAULT_MAX_AMOUNT_ATOMIC.toString()}. ` +
      'Does NOT apply to Embedded charges.',
  )
  .option(
    '--auto-embedded',
    'Auto-sign Embedded-flow charges up to --max-embedded-amount instead of prompting.',
  )
  .option(
    '--max-embedded-amount <atomic>',
    'Ceiling (in atomic units) used when --auto-embedded is set. Required with --auto-embedded.',
  )
  .option(
    '--no-embedded',
    'Refuse every Embedded-flow charge outright (useful for scripts).',
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
        autoEmbedded?: boolean;
        maxEmbeddedAmount?: string;
        embedded?: boolean;
      },
    ) => {
      try {
        const gateMaxAmount = parseMaxAmount(opts.maxAmount);
        const embeddedPolicy = parseEmbeddedPolicy({
          noEmbedded: opts.embedded === false,
          autoEmbedded: opts.autoEmbedded,
          maxEmbeddedAmount: opts.maxEmbeddedAmount,
          json: opts.json,
        });

        const client = createClient(url, opts);

        const baseMessage: SendMessageParams['message'] = {
          messageId: crypto.randomUUID(),
          role: 'user',
          parts: [{ text: message }],
          ...(opts.contextId ? { contextId: opts.contextId } : {}),
        };

        if (!opts.json) {
          console.log(chalk.bold.cyan('Streaming response...'));
          console.log(chalk.gray('─'.repeat(40)));
        }

        let currentParams: SendMessageParams = { message: baseMessage };

        for (let hop = 0; hop <= MAX_PAYMENT_HOPS; hop += 1) {
          const signal = await consumeUntilPaymentRequired(
            client.sendMessageStream(currentParams),
            opts,
          );

          if (!signal) {
            // Stream finished normally — no (further) payment required.
            finish(opts);
            return;
          }

          if (hop === MAX_PAYMENT_HOPS) {
            if (!opts.json) {
              console.log();
              console.error(
                chalk.yellow(
                  `Giving up: server asked for more than ${MAX_PAYMENT_HOPS} payments in one call.`,
                ),
              );
            }
            process.exit(2);
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

          // Per-hop policy: gate uses --max-amount auto-sign; embedded
          // consults parseEmbeddedPolicy (prompt / auto / refuse).
          if (signal.kind === 'standalone') {
            enforceBudget(signal.required, gateMaxAmount, 'gate');
            if (!opts.json) {
              console.log();
              printPaymentRequirement(signal.required, gateMaxAmount);
            }
          } else if (signal.embedded) {
            await confirmEmbeddedPayment(signal.embedded, embeddedPolicy, {
              json: opts.json,
            });
          }

          const signed = await signX402Payment(signal.syntheticTask, {
            signer,
            selectRequirement: (accepts) =>
              signal.kind === 'standalone'
                ? pickAffordableRequirement(
                    { x402Version: 1, accepts },
                    gateMaxAmount,
                  )
                : pickCheapestExactForEmbedded(accepts, embeddedPolicy),
          });

          if (!opts.json) {
            console.log(
              chalk.gray(
                `  signed ${signed.requirement.maxAmountRequired} atomic → resuming stream`,
              ),
            );
            console.log();
          }

          currentParams = {
            ...currentParams,
            message: {
              ...baseMessage,
              messageId: crypto.randomUUID(),
              taskId: signal.taskId,
              contextId: signal.contextId,
              metadata: {
                ...(baseMessage.metadata ?? {}),
                ...signed.metadata,
              },
            },
          };
        }
      } catch (err) {
        const code = printX402Error(err);
        if (code !== null) process.exit(code);
        printConnectionError(err, url);
        process.exit(1);
      }
    },
  );

/**
 * After `confirmEmbeddedPayment` has approved the spend, pick which
 * requirement to sign. Under an auto policy we still respect the
 * ceiling; under a prompt or refuse policy the user's `y` applies to
 * whatever cheapest `exact`-scheme requirement we pick.
 */
function pickCheapestExactForEmbedded(
  accepts: X402PaymentRequirements[],
  policy: EmbeddedPolicy,
): X402PaymentRequirements | undefined {
  if (policy.kind === 'auto') {
    return pickAffordableRequirement(
      { x402Version: 1, accepts },
      policy.maxAmount,
    );
  }
  return pickCheapestExact(accepts);
}

/**
 * Iterate the stream, printing events as they come in. Pauses as
 * soon as a pending x402 challenge surfaces (Standalone via status
 * metadata, or Embedded via an accumulated artifact) and returns a
 * synthetic Task for the caller to sign against.
 */
async function consumeUntilPaymentRequired(
  stream: AsyncGenerator<StreamEvent>,
  opts: { json?: boolean },
): Promise<PaymentSignal | undefined> {
  const artifacts: Artifact[] = [];

  for await (const event of stream) {
    if (!('status' in event)) {
      captureArtifact(artifacts, event);
      renderEvent(event, opts);
      continue;
    }

    const meta = (event.status.message?.metadata ?? {}) as Record<string, unknown>;
    const x402Status = meta[X402_METADATA_KEYS.STATUS];
    const pending =
      event.status.state === 'input-required' &&
      x402Status === X402_PAYMENT_STATUS.REQUIRED;

    if (pending) {
      const syntheticTask: Task = {
        id: event.taskId,
        contextId: event.contextId,
        status: event.status,
        artifacts,
      };

      const standalone = getX402PaymentRequirements(syntheticTask);
      if (standalone) {
        renderEvent(event, opts);
        return {
          kind: 'standalone',
          required: standalone,
          syntheticTask,
          taskId: event.taskId,
          contextId: event.contextId,
        };
      }

      const embedded = getEmbeddedX402Challenges(syntheticTask);
      if (embedded.length > 0) {
        const first = embedded[0]!;
        renderEvent(event, opts);
        return {
          kind: 'embedded',
          required: first.required,
          embedded: first,
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

function captureArtifact(
  artifacts: Artifact[],
  event: TaskArtifactUpdateEvent,
): void {
  const idx = artifacts.findIndex(
    (a) => a.artifactId === event.artifact.artifactId,
  );
  if (idx < 0) {
    artifacts.push({ ...event.artifact });
    return;
  }
  const current = artifacts[idx]!;
  if (event.append) {
    artifacts[idx] = {
      ...current,
      parts: [...current.parts, ...event.artifact.parts],
    };
  } else {
    artifacts[idx] = { ...event.artifact };
  }
}

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
    return;
  }
  if (isEmbeddedChallengeArtifact(event.artifact)) {
    flushLine();
    return;
  }
  printArtifactChunk(event, true);
  if (event.artifact.parts.some((p) => 'text' in p)) {
    midLine = true;
  }
  if (event.lastChunk) {
    flushLine();
  }
}

function finish(opts: { json?: boolean }): void {
  if (opts.json) return;
  flushLine();
  console.log(chalk.gray('─'.repeat(40)));
  console.log(chalk.green('Stream completed'));
}
