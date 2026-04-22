/**
 * Shared x402 helpers used by `a2x a2a send` and `a2x a2a stream`.
 *
 * The SDK exposes `X402Client.onPaymentRequired` and `selectRequirement`
 * as callbacks. The CLI wires them to a spend ceiling so an auto-signed
 * payment can never exceed `--max-amount` — if the server advertises
 * only expensive options we throw `X402BudgetExceededError` before any
 * EIP-3009 authorization gets signed.
 */

import chalk from 'chalk';
import type {
  SignX402PaymentOptions,
  X402ClientOptions,
  X402PaymentRequiredResponse,
  X402PaymentRequirements,
} from '@a2x/sdk';
import { X402PaymentFailedError } from '@a2x/sdk';

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
 * Build the `{ onPaymentRequired, selectRequirement }` pair that both
 * `X402Client` (used by send) and the manual payment dance in stream
 * should share. Takes the same `SignX402PaymentOptions.signer` shape
 * so callers can spread `{ signer, ...buildBudgetedX402ClientOptions }`
 * without repeating themselves.
 */
export function buildBudgetedX402ClientOptions(
  maxAmount: bigint,
): Pick<X402ClientOptions, 'onPaymentRequired' | 'selectRequirement'> {
  return {
    onPaymentRequired: (r) => {
      const affordable = r.accepts.filter(
        (a) => safeBigInt(a.maxAmountRequired) <= maxAmount,
      );
      if (affordable.length === 0) {
        const cheapest = r.accepts
          .map((a) => ({ v: safeBigInt(a.maxAmountRequired), asset: a.asset }))
          .sort((x, y) => (x.v < y.v ? -1 : 1))[0];
        throw new X402BudgetExceededError(
          cheapest?.v ?? 0n,
          maxAmount,
          cheapest?.asset ?? 'unknown',
        );
      }
    },
    selectRequirement: (accepts) => {
      const affordable = accepts
        .filter((a) => safeBigInt(a.maxAmountRequired) <= maxAmount)
        .sort((x, y) =>
          safeBigInt(x.maxAmountRequired) < safeBigInt(y.maxAmountRequired)
            ? -1
            : 1,
        );
      return affordable.find((a) => a.scheme === 'exact') ?? affordable[0];
    },
  };
}

/**
 * Combine `signer` + budget callbacks into a full `X402ClientOptions`
 * in one call.
 */
export function buildBudgetedX402ClientSettings(args: {
  signer: SignX402PaymentOptions['signer'];
  maxAmount: bigint;
}): X402ClientOptions {
  return {
    signer: args.signer,
    ...buildBudgetedX402ClientOptions(args.maxAmount),
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
