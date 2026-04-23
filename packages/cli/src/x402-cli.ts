/**
 * Shared x402 helpers used by `a2x a2a send` and `a2x a2a stream`.
 *
 * The two flows defined by a2a-x402 v0.2 map to very different UX:
 *
 *  - **Standalone gate.** Typically a tiny anti-spam/access fee. The
 *    CLI auto-signs anything under `--max-amount` (10_000 atomic by
 *    default — 0.01 USDC on a 6-decimal stablecoin). Raising this
 *    ceiling is safe because everything above it refuses up-front,
 *    before any signature.
 *  - **Embedded flow.** Mid-execution per-purchase charge (cart
 *    checkout, premium asset delivery). Amounts are arbitrary and
 *    *can be high*, so auto-signing under a generous ceiling is
 *    dangerous — a buggy/malicious merchant could drain a wallet.
 *    The CLI therefore requires explicit per-hop approval:
 *
 *    - Default (TTY): pause, print challenge, prompt `y/N`.
 *    - `--auto-embedded --max-embedded-amount N`: auto-sign up to N.
 *    - `--no-embedded`: refuse any embedded charge outright.
 *    - Non-TTY or `--json` mode: refuse by default (can't prompt);
 *      caller must opt into `--auto-embedded` explicitly.
 *
 * All policy decisions live here so `send.ts` and `stream.ts` share
 * one implementation.
 */

import { createInterface } from 'node:readline';
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
 * auto-signed x402 gate payment. 10_000 on a 6-decimal stablecoin is
 * 0.01 USDC — a paranoid default for a CLI that holds real keys.
 *
 * Only affects the **Standalone gate**. Embedded charges never use
 * this ceiling; they always require explicit approval.
 */
export const DEFAULT_MAX_AMOUNT_ATOMIC = 10_000n;

/**
 * Thrown when the server asks for a payment the configured budget
 * can't cover. Used for both gate-exceeded and auto-embedded-exceeded.
 */
export class X402BudgetExceededError extends Error {
  constructor(
    public readonly cheapest: bigint,
    public readonly budget: bigint,
    public readonly asset: string,
    public readonly scope: 'gate' | 'embedded' = 'gate',
  ) {
    super(
      `Refusing to pay: cheapest advertised ${scope} amount ${cheapest.toString()} (atomic of ${asset}) exceeds budget ${budget.toString()}.`,
    );
    this.name = 'X402BudgetExceededError';
  }
}

/**
 * Thrown when the user says "no" at the embedded-payment prompt, when
 * `--no-embedded` is active, or when a non-interactive invocation
 * tries to trigger an embedded charge without `--auto-embedded`.
 */
export class X402EmbeddedDeclinedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'X402EmbeddedDeclinedError';
  }
}

// ─── Amount parsing ────────────────────────────────────────────────

/** Parse the --max-amount CLI value; fall back to the gate default. */
export function parseMaxAmount(raw: string | undefined): bigint {
  if (raw === undefined) return DEFAULT_MAX_AMOUNT_ATOMIC;
  return parseAtomic(raw, '--max-amount');
}

function parseAtomic(raw: string, flag: string): bigint {
  if (!/^\d+$/.test(raw)) {
    throw new Error(
      `${flag} must be a non-negative integer in atomic units; got "${raw}".`,
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

// ─── Embedded policy ───────────────────────────────────────────────

export type EmbeddedPolicy =
  | { kind: 'prompt' } // Interactive Y/N
  | { kind: 'auto'; maxAmount: bigint } // Auto-sign up to maxAmount
  | { kind: 'refuse' }; // Hard refuse every embedded charge

export interface EmbeddedPolicyOpts {
  noEmbedded?: boolean;
  autoEmbedded?: boolean;
  maxEmbeddedAmount?: string;
  json?: boolean;
}

/**
 * Resolve the CLI flags into a concrete embedded-payment policy. This
 * is the single source of truth for "should the CLI sign an embedded
 * charge without human input?" — callers just dispatch on the
 * returned `kind`.
 */
export function parseEmbeddedPolicy(opts: EmbeddedPolicyOpts): EmbeddedPolicy {
  if (opts.noEmbedded) return { kind: 'refuse' };

  if (opts.autoEmbedded) {
    if (opts.maxEmbeddedAmount === undefined) {
      throw new Error(
        '--auto-embedded requires --max-embedded-amount <atomic> so the CLI has an explicit ceiling.',
      );
    }
    return {
      kind: 'auto',
      maxAmount: parseAtomic(opts.maxEmbeddedAmount, '--max-embedded-amount'),
    };
  }

  if (opts.maxEmbeddedAmount !== undefined) {
    throw new Error(
      '--max-embedded-amount requires --auto-embedded; otherwise the prompt decides.',
    );
  }

  // Neither auto nor refuse: prompt when interactive, refuse otherwise.
  if (opts.json || !process.stdin.isTTY) {
    return { kind: 'refuse' };
  }
  return { kind: 'prompt' };
}

/**
 * Apply the resolved policy to one embedded challenge. Returns on
 * approval; throws on refusal (callers propagate to exit).
 */
export async function confirmEmbeddedPayment(
  challenge: EmbeddedX402Challenge,
  policy: EmbeddedPolicy,
  opts: { json?: boolean } = {},
): Promise<void> {
  const verbose = opts.json !== true;
  const cheapest = cheapestAmount(challenge.required);

  if (policy.kind === 'refuse') {
    throw new X402EmbeddedDeclinedError(
      `Embedded payment refused (--no-embedded or non-interactive session). ` +
        `Cheapest advertised amount: ${cheapest.v.toString()} atomic of ${cheapest.asset}.`,
    );
  }

  if (policy.kind === 'auto') {
    if (verbose) {
      console.log();
      printEmbeddedChallenge(challenge, policy.maxAmount);
      console.log(
        chalk.gray(
          `  auto-approving under --max-embedded-amount ${policy.maxAmount.toString()}`,
        ),
      );
    }
    if (cheapest.v > policy.maxAmount) {
      throw new X402BudgetExceededError(
        cheapest.v,
        policy.maxAmount,
        cheapest.asset,
        'embedded',
      );
    }
    return;
  }

  // Interactive prompt.
  if (verbose) {
    console.log();
    printEmbeddedChallenge(challenge, cheapest.v);
  }
  const ok = await promptYesNo(
    chalk.bold.yellow('  Approve this embedded payment? ') + chalk.gray('[y/N] '),
  );
  if (!ok) {
    throw new X402EmbeddedDeclinedError('User declined embedded payment.');
  }
}

function cheapestAmount(required: X402PaymentRequiredResponse): {
  v: bigint;
  asset: string;
} {
  const sorted = required.accepts
    .map((a) => ({ v: safeBigInt(a.maxAmountRequired), asset: a.asset }))
    .sort((x, y) => (x.v < y.v ? -1 : 1));
  return sorted[0] ?? { v: 0n, asset: 'unknown' };
}

// ─── Interactive prompt ────────────────────────────────────────────

async function promptYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(/^y(es)?$/i.test(answer.trim()));
    });
  });
}

// ─── X402ClientOptions builder (send path) ─────────────────────────

export interface X402CliSettingsArgs {
  signer: SignX402PaymentOptions['signer'];
  gateMaxAmount: bigint;
  embeddedPolicy: EmbeddedPolicy;
  verbose?: boolean;
  json?: boolean;
}

/**
 * Assemble the full `X402ClientOptions` used by `a2x a2a send`.
 *
 * The callbacks enforce policy *before* signatures:
 *
 *  - `onPaymentRequired` refuses gate charges over `gateMaxAmount`.
 *  - `onEmbeddedPaymentRequired` runs the embedded policy (prompt,
 *    auto-with-ceiling, or refuse).
 *  - `selectRequirement` picks the cheapest `exact` option. It does
 *    NOT filter by budget — the callbacks own that decision, per
 *    hop, so the gate ceiling can't silently apply to embedded.
 */
export function buildBudgetedX402ClientSettings(
  args: X402CliSettingsArgs,
): X402ClientOptions {
  return {
    signer: args.signer,
    onPaymentRequired: (required) => {
      enforceBudget(required, args.gateMaxAmount, 'gate');
    },
    onEmbeddedPaymentRequired: async (challenge) => {
      await confirmEmbeddedPayment(challenge, args.embeddedPolicy, {
        json: args.json,
      });
    },
    selectRequirement: (accepts) => pickCheapestExact(accepts),
  };
}

/**
 * Enforce a budget without going through `X402Client`. Used by the
 * gate check in the stream path and by the auto-embedded ceiling.
 */
export function enforceBudget(
  required: X402PaymentRequiredResponse,
  maxAmount: bigint,
  scope: 'gate' | 'embedded' = 'gate',
): void {
  const affordable = required.accepts.filter(
    (a) => safeBigInt(a.maxAmountRequired) <= maxAmount,
  );
  if (affordable.length === 0) {
    const cheapest = cheapestAmount(required);
    throw new X402BudgetExceededError(cheapest.v, maxAmount, cheapest.asset, scope);
  }
}

/** Pick the cheapest affordable "exact" requirement. */
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

/**
 * Pick the cheapest `exact`-scheme requirement from a list without a
 * budget filter. Used after policy has already approved the spend.
 */
export function pickCheapestExact(
  accepts: X402PaymentRequirements[],
): X402PaymentRequirements | undefined {
  const sorted = [...accepts].sort((x, y) =>
    safeBigInt(x.maxAmountRequired) < safeBigInt(y.maxAmountRequired)
      ? -1
      : 1,
  );
  return sorted.find((a) => a.scheme === 'exact') ?? sorted[0];
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
      `  (gate budget: ${budget.toString()} atomic — use --max-amount to change)`,
    ),
  );
  console.log();
}

export function printEmbeddedChallenge(
  challenge: EmbeddedX402Challenge,
  ceiling: bigint,
): void {
  console.log(chalk.bold.magenta('x402: embedded payment required'));
  console.log(chalk.gray('─'.repeat(40)));
  if (challenge.artifactName) {
    console.log(`  ${chalk.bold('artifact:')} ${challenge.artifactName}`);
  }
  const summary = summarizeEmbeddedData(challenge.data);
  if (summary.length > 0) {
    for (const line of summary) console.log(`  ${line}`);
  }
  for (const accept of challenge.required.accepts) {
    printAccept(accept, ceiling);
  }
}

function summarizeEmbeddedData(data: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (key === 'x402.payment.required') continue;
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      out.push(`${chalk.bold(`${key}:`)} ${String(value)}`);
    } else {
      out.push(`${chalk.bold(`${key}:`)} ${chalk.gray(JSON.stringify(value))}`);
    }
  }
  return out;
}

function printAccept(accept: X402PaymentRequirements, ceiling: bigint): void {
  const amount = accept.maxAmountRequired;
  const overCeiling = safeBigInt(amount) > ceiling;
  const amountLine = overCeiling
    ? chalk.red(`${amount} (over budget)`)
    : amount;
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
 * either the bare SDK shape (`x402.payment.required` key on a data
 * part) or any `x402PaymentRequiredResponse`-shaped object nested
 * inside a higher-level wrapper.
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
 * Centralised pretty-printer for the x402 error classes the CLI can
 * surface. Returns the exit code the caller should use, or `null` if
 * the error wasn't an x402 one (caller handles it).
 */
export function printX402Error(err: unknown): number | null {
  if (err instanceof X402BudgetExceededError) {
    console.error();
    console.error(
      chalk.red('✗'),
      chalk.bold.red(
        err.scope === 'embedded'
          ? 'x402 embedded payment refused (over budget)'
          : 'x402 gate payment refused (over budget)',
      ),
    );
    console.error(
      `  cheapest option: ${err.cheapest.toString()} atomic of ${err.asset}`,
    );
    console.error(`  budget:          ${err.budget.toString()}`);
    if (err.scope === 'embedded') {
      console.error(
        chalk.yellow(
          '\n  Raise the ceiling with `--max-embedded-amount <atomic>` if you trust the merchant.',
        ),
      );
    } else {
      console.error(
        chalk.yellow(
          '\n  Raise the ceiling with `--max-amount <atomic>` if you trust the merchant.',
        ),
      );
    }
    return 2;
  }

  if (err instanceof X402EmbeddedDeclinedError) {
    console.error();
    console.error(
      chalk.red('✗'),
      chalk.bold.red('x402 embedded payment declined'),
    );
    console.error(`  ${err.message}`);
    console.error(
      chalk.yellow(
        '\n  Re-run with `--auto-embedded --max-embedded-amount <atomic>` to skip the prompt.',
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
