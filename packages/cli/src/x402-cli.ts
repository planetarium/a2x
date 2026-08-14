/**
 * Shared x402 helpers used by `a2x a2a send` and `a2x a2a stream`.
 *
 * The SDK's `A2XClient` runs the x402 dance natively when given an
 * `x402` option. This module wires the CLI's spend ceiling and friendly
 * error messages onto that surface — so an auto-signed payment can never
 * exceed `--max-amount` and a budget violation surfaces with a CLI-shaped
 * message instead of the generic "no supported requirement" error.
 */

import chalk from 'chalk';
import type { A2XClientX402Options } from '@a2x/sdk';
import {
  X402PaymentFailedError,
  requirementAmount,
  type SignX402PaymentOptions,
  type X402PaymentRequiredResponse,
  type X402PaymentRequirements,
} from '@a2x/sdk/x402';

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

/**
 * Thrown by our onPaymentRequired callback when the only affordable offers
 * use the `upto` scheme and the user did not pass --allow-upto. Signing an
 * `upto` offer authorizes the merchant to draw anything up to `amount`
 * (metered billing), a broader consent than an exact payment — the SDK
 * deliberately refuses to auto-select it, and without this error the CLI
 * would surface only the generic "no supported requirement" message with no
 * hint at the flag that fixes it.
 */
export class X402UptoConsentRequiredError extends Error {
  constructor(public readonly maxAuthorized: bigint, public readonly asset: string) {
    super(
      `The agent only offers 'upto' (metered) billing, which authorizes it to draw anything up to ${maxAuthorized.toString()} atomic units. Re-run with --allow-upto to consent.`,
    );
    this.name = 'X402UptoConsentRequiredError';
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
 * Build the `A2XClientX402Options` block the CLI hands to `A2XClient`.
 *
 * `maxAmount` is enforced twice: in the SDK's default selector (so a
 * caller-supplied predicate also sees only affordable options) and in
 * our `onPaymentRequired` hook, which prints the requirements and throws
 * `X402BudgetExceededError` up-front when nothing fits — that gives a
 * better CLI message than letting the SDK fall through to the generic
 * "no supported requirement" error. The same hook throws
 * `X402UptoConsentRequiredError` when the agent's only affordable offers
 * need the --allow-upto consent the user didn't give.
 *
 * `rpcUrl` (from --rpc-url / A2X_RPC_URL / config) feeds the `upto` payer's
 * on-chain reads so it can produce the gas-sponsored Permit2 approval a
 * merchant may require; without it such merchants reject with
 * `permit2_allowance_required`.
 */
export function buildBudgetedX402ClientSettings(args: {
  signer: SignX402PaymentOptions['signer'];
  maxAmount: bigint;
  allowUpto?: boolean;
  rpcUrl?: string;
}): A2XClientX402Options {
  const { signer, maxAmount, allowUpto, rpcUrl } = args;
  return {
    signer,
    maxAmount,
    ...(allowUpto ? { allowUpto: true } : {}),
    ...(rpcUrl ? { upto: { rpcUrl } } : {}),
    onPaymentRequired: (required) => {
      printPaymentRequirement(required, maxAmount);
      const accepts = required.accepts as X402PaymentRequirements[];
      const affordable = accepts.filter(
        (a) => safeBigInt(requirementAmount(a)) <= maxAmount,
      );
      if (affordable.length === 0) {
        const cheapest = accepts
          .map((a) => ({ v: safeBigInt(requirementAmount(a)), asset: a.asset }))
          .sort((x, y) => (x.v < y.v ? -1 : 1))[0];
        throw new X402BudgetExceededError(
          cheapest?.v ?? 0n,
          maxAmount,
          cheapest?.asset ?? 'unknown',
        );
      }
      if (!allowUpto && affordable.every((a) => a.scheme !== 'exact')) {
        const upto = affordable.find((a) => a.scheme === 'upto');
        if (upto) {
          throw new X402UptoConsentRequiredError(
            safeBigInt(requirementAmount(upto)),
            upto.asset,
          );
        }
      }
    },
  };
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
  const amount = requirementAmount(accept);
  const overBudget = safeBigInt(amount) > budget;
  const amountLine = overBudget ? chalk.red(`${amount} (over budget)`) : amount;
  console.log(`  ${chalk.bold('network:')}  ${chalk.cyan(accept.network)}`);
  console.log(`  ${chalk.bold('scheme:')}   ${accept.scheme}`);
  console.log(
    `  ${chalk.bold('amount:')}   ${amountLine} (atomic units of ${accept.asset.slice(0, 10)}…)`,
  );
  console.log(`  ${chalk.bold('pay to:')}   ${accept.payTo}`);
  // `description` is inline only on V1 requirements; V2 carries it on the
  // top-level `resource` object.
  if ('description' in accept && accept.description) {
    console.log(`  ${chalk.bold('note:')}     ${accept.description}`);
  }
}

// ─── Error handling ─────────────────────────────────────────────────

/**
 * Match the SDK's `X402PaymentFailedError` across bundle boundaries.
 *
 * `@a2x/sdk`'s entry points are bundled independently, so the class that
 * `A2XClient` (imported from `@a2x/sdk`) throws is a different object from
 * the one this module imports from `@a2x/sdk/x402` — a plain `instanceof`
 * never matches and every payment failure would fall through to the generic
 * connection-error path. The `name` field is the stable discriminator.
 */
function asX402PaymentFailedError(
  err: unknown,
): X402PaymentFailedError | null {
  if (err instanceof X402PaymentFailedError) return err;
  if (err instanceof Error && err.name === 'X402PaymentFailedError') {
    return err as X402PaymentFailedError;
  }
  return null;
}

/**
 * Centralised pretty-printer for the x402 error classes the CLI can
 * surface. Returns the exit code the caller should use, or `null` if
 * the error wasn't an x402 one (caller handles it).
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

  if (err instanceof X402UptoConsentRequiredError) {
    console.error();
    console.error(
      chalk.red('✗'),
      chalk.bold.red("x402 payment refused ('upto' consent required)"),
    );
    console.error(
      `  The agent only offers metered ('upto') billing: it may draw anything`,
    );
    console.error(
      `  up to ${err.maxAuthorized.toString()} atomic of ${err.asset}, charging only actual usage.`,
    );
    console.error(
      chalk.yellow(
        '\n  Re-run with `--allow-upto` to authorize it (still capped by --max-amount).',
      ),
    );
    return 2;
  }

  const paymentFailed = asX402PaymentFailedError(err);
  if (paymentFailed) {
    console.error();
    console.error(
      chalk.red('✗'),
      chalk.bold.red('x402 payment failed'),
      chalk.gray(`(${paymentFailed.code})`),
    );
    console.error(`  ${paymentFailed.message}`);
    if (paymentFailed.transaction) {
      console.error(
        `  tx: ${paymentFailed.transaction} (${paymentFailed.network ?? 'unknown'})`,
      );
    }
    if (paymentFailed.code === 'permit2_allowance_required') {
      console.error(
        chalk.yellow(
          '\n  The merchant needs a Permit2 allowance for your wallet. Pass `--rpc-url <url>`\n' +
            '  (or set A2X_RPC_URL) so the CLI can attach a gas-sponsored approval, or\n' +
            '  approve Permit2 for the asset on-chain yourself first.',
        ),
      );
    }
    return 2;
  }

  return null;
}
