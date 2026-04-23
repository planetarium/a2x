/**
 * Shared x402 helpers used by `a2x a2a send` and `a2x a2a stream`.
 *
 * The SDK exposes budget-shaped callbacks on both flows:
 *
 *  - `onPaymentRequired` / `selectRequirement` for the Standalone gate
 *    (see a2a-x402 v0.2 §5.1 Standalone flow).
 *  - `onEmbeddedPaymentRequired` for each mid-execution charge
 *    (v0.2 §5.1 Embedded flow).
 *
 * The CLI wires both to a spend ceiling so no EIP-3009 authorization is
 * ever signed for more than `--max-amount` — the refusal happens
 * BEFORE the signature, not after.
 */

import chalk from 'chalk';
import type {
  Artifact,
  EmbeddedX402Challenge,
  SignX402PaymentOptions,
  Task,
  X402ClientOptions,
  X402PaymentRequiredResponse,
  X402PaymentRequirements,
} from '@a2x/sdk';
import {
  X402PaymentFailedError,
  getEmbeddedX402Challenges,
} from '@a2x/sdk';
import { TaskState } from '@a2x/sdk';

/**
 * Default spend ceiling, in the asset's atomic units, applied to every
 * auto-signed x402 payment. 10_000 on a 6-decimal stablecoin is 0.01 USDC.
 *
 * Anything the server asks for above this will be refused up-front,
 * before we sign — a paranoid default for a CLI that holds real keys.
 * Override explicitly with --max-amount.
 */
export const DEFAULT_MAX_AMOUNT_ATOMIC = 10_000n;

/**
 * Thrown by our onPaymentRequired callback when every payment option
 * advertised by the server exceeds the configured budget. The outer
 * command-level catch recognises it and prints a dedicated message
 * with remediation hints.
 */
export class X402BudgetExceededError extends Error {
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

/** Parse the --max-amount CLI value; fall back to the default. */
export function parseMaxAmount(raw: string | undefined): bigint {
  if (raw === undefined) return DEFAULT_MAX_AMOUNT_ATOMIC;
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `--max-amount must be a non-negative integer in atomic units; got "${raw}".`,
    );
  }
  return BigInt(raw);
}

/**
 * Safe BigInt coercion. An invalid amount string must not silently
 * pass the budget check, so we return a value bigger than anything a
 * real network can carry.
 */
export function safeBigInt(raw: string): bigint {
  try {
    return BigInt(raw);
  } catch {
    return 2n ** 256n;
  }
}

/**
 * Combine `signer` + budget callbacks (gate + embedded) into a full
 * `X402ClientOptions` block.
 *
 * `verbose` controls whether the embedded-hop callback prints the
 * challenge to stdout — on by default for interactive UX, disabled in
 * `--json` mode.
 */
export function buildBudgetedX402ClientSettings(args: {
  signer: SignX402PaymentOptions['signer'];
  maxAmount: bigint;
  verbose?: boolean;
}): X402ClientOptions {
  const verbose = args.verbose ?? true;
  return {
    signer: args.signer,
    onPaymentRequired: (required) => {
      enforceBudget(required, args.maxAmount);
    },
    onEmbeddedPaymentRequired: (challenge: EmbeddedX402Challenge) => {
      if (verbose) {
        console.log();
        printEmbeddedChallenge(challenge, args.maxAmount);
      }
      enforceBudget(challenge.required, args.maxAmount);
    },
    selectRequirement: (accepts) => {
      const affordable = accepts
        .filter((a) => safeBigInt(a.maxAmountRequired) <= args.maxAmount)
        .sort((x, y) =>
          safeBigInt(x.maxAmountRequired) < safeBigInt(y.maxAmountRequired)
            ? -1
            : 1,
        );
      return affordable.find((a) => a.scheme === 'exact') ?? affordable[0];
    },
  };
}

/** Enforce the budget without going through `X402Client` (stream path). */
export function enforceBudget(
  required: X402PaymentRequiredResponse,
  maxAmount: bigint,
): void {
  const affordable = required.accepts.filter(
    (a) => safeBigInt(a.maxAmountRequired) <= maxAmount,
  );
  if (affordable.length === 0) {
    const cheapest = required.accepts
      .map((a) => ({ v: safeBigInt(a.maxAmountRequired), asset: a.asset }))
      .sort((x, y) => (x.v < y.v ? -1 : 1))[0];
    throw new X402BudgetExceededError(
      cheapest?.v ?? 0n,
      maxAmount,
      cheapest?.asset ?? 'unknown',
    );
  }
}

/** Pick the cheapest affordable "exact" requirement without X402Client. */
export function pickAffordableRequirement(
  required: X402PaymentRequiredResponse,
  maxAmount: bigint,
): X402PaymentRequirements | undefined {
  const affordable = required.accepts
    .filter((a) => safeBigInt(a.maxAmountRequired) <= maxAmount)
    .sort((x, y) =>
      safeBigInt(x.maxAmountRequired) < safeBigInt(y.maxAmountRequired)
        ? -1
        : 1,
    );
  return affordable.find((a) => a.scheme === 'exact') ?? affordable[0];
}

// ─── Display helpers ────────────────────────────────────────────────

export function printPaymentRequirement(
  required: X402PaymentRequiredResponse,
  budget: bigint,
): void {
  console.log(chalk.bold.magenta('x402: payment required'));
  console.log(chalk.gray('─'.repeat(40)));
  for (const accept of required.accepts) {
    printAccept(accept, budget);
  }
  console.log(
    chalk.gray(
      `  (budget: ${budget.toString()} atomic — use --max-amount to change)`,
    ),
  );
  console.log();
}

export function printEmbeddedChallenge(
  challenge: EmbeddedX402Challenge,
  budget: bigint,
): void {
  console.log(chalk.bold.magenta('x402: embedded payment required'));
  console.log(chalk.gray('─'.repeat(40)));
  if (challenge.artifactName) {
    console.log(`  ${chalk.bold('artifact:')} ${challenge.artifactName}`);
  }
  // Surface any non-x402 fields on the data wrapper (cartId, total, etc.)
  // so the user sees what they're paying for.
  const summary = summarizeEmbeddedData(challenge.data);
  if (summary.length > 0) {
    for (const line of summary) console.log(`  ${line}`);
  }
  for (const accept of challenge.required.accepts) {
    printAccept(accept, budget);
  }
  console.log(
    chalk.gray(
      `  (budget: ${budget.toString()} atomic — use --max-amount to change)`,
    ),
  );
  console.log();
}

function summarizeEmbeddedData(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    // Skip the x402 challenge itself; the rows below already print it.
    if (key === 'x402.payment.required') continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out.push(`${chalk.bold(`${key}:`)} ${String(value)}`);
    } else {
      // Compact JSON for nested shapes (cart items list, total object, …).
      out.push(`${chalk.bold(`${key}:`)} ${chalk.gray(JSON.stringify(value))}`);
    }
  }
  return out;
}

function printAccept(accept: X402PaymentRequirements, budget: bigint): void {
  const amount = accept.maxAmountRequired;
  const overBudget = safeBigInt(amount) > budget;
  const amountLine = overBudget ? chalk.red(`${amount} (over budget)`) : amount;
  console.log(`  ${chalk.bold('network:')}  ${chalk.cyan(accept.network)}`);
  console.log(`  ${chalk.bold('scheme:')}   ${accept.scheme}`);
  console.log(
    `  ${chalk.bold('amount:')}   ${amountLine} (atomic units of ${accept.asset.slice(0, 10)}…)`,
  );
  console.log(`  ${chalk.bold('pay to:')}   ${accept.payTo}`);
  if (accept.description) {
    console.log(`  ${chalk.bold('note:')}     ${accept.description}`);
  }
}

// ─── Artifact classification (stream path) ─────────────────────────

/**
 * True when `artifact` carries an x402 embedded payment challenge —
 * either the bare SDK shape (`x402.payment.required` key on a data part)
 * or any `x402PaymentRequiredResponse`-shaped object nested inside a
 * higher-level wrapper.
 *
 * The stream command uses this to skip dumping the raw challenge JSON
 * into the text stream; the payment-dance block re-renders it with
 * proper formatting.
 */
export function isEmbeddedChallengeArtifact(artifact: Artifact): boolean {
  const probe: Task = {
    id: '_probe',
    status: { state: TaskState.INPUT_REQUIRED },
    artifacts: [artifact],
  };
  return getEmbeddedX402Challenges(probe).length > 0;
}

// ─── Error handling ─────────────────────────────────────────────────

/**
 * Centralised pretty-printer for the three x402 error classes the
 * CLI can surface. Returns the exit code the caller should use, or
 * `null` if the error wasn't an x402 one (caller handles it).
 */
export function printX402Error(err: unknown): number | null {
  if (err instanceof X402BudgetExceededError) {
    console.error();
    console.error(
      chalk.red('✗'),
      chalk.bold.red('x402 payment refused (over budget)'),
    );
    console.error(
      `  cheapest option: ${err.cheapest.toString()} atomic of ${err.asset}`,
    );
    console.error(`  --max-amount:    ${err.budget.toString()}`);
    console.error(
      chalk.yellow(
        '\n  Raise the ceiling with `--max-amount <atomic>` if you trust the merchant.',
      ),
    );
    return 2;
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
    return 2;
  }

  return null;
}
