/**
 * Tests for the separated gate/embedded budget policy the CLI applies
 * before signing any x402 authorization.
 *
 * The policy lives in `x402-cli.ts` as `parseEmbeddedPolicy` +
 * `confirmEmbeddedPayment`. Both `a2a send` and `a2a stream` call the
 * same helpers so this file is the single source of truth for the
 * "don't silently auto-sign a big embedded charge" guarantee.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { EmbeddedX402Challenge } from '@a2x/sdk';
import {
  confirmEmbeddedPayment,
  parseEmbeddedPolicy,
  X402BudgetExceededError,
  X402EmbeddedDeclinedError,
} from '../x402-cli.js';

// ─── Fixtures ──────────────────────────────────────────────────────

function challenge(amount: string): EmbeddedX402Challenge {
  return {
    artifactId: 'challenge-1',
    artifactName: 'demo-cart',
    required: {
      x402Version: 1,
      accepts: [
        {
          scheme: 'exact',
          network: 'base-sepolia',
          maxAmountRequired: amount,
          resource: 'a2a-x402/access',
          description: 'Checkout',
          mimeType: 'application/json',
          payTo: '0x1111111111111111111111111111111111111111',
          maxTimeoutSeconds: 300,
          asset: '0x2222222222222222222222222222222222222222',
          extra: { name: 'USDC', version: '2' },
        },
      ],
    },
    data: {
      cartId: 'cart-xyz',
      'x402.payment.required': {
        x402Version: 1,
        accepts: [{ scheme: 'exact', maxAmountRequired: amount }],
      },
    },
  };
}

// ─── parseEmbeddedPolicy ──────────────────────────────────────────

describe('parseEmbeddedPolicy', () => {
  it('returns "refuse" when --no-embedded is set', () => {
    expect(parseEmbeddedPolicy({ noEmbedded: true })).toEqual({ kind: 'refuse' });
  });

  it('returns "auto" with ceiling when --auto-embedded + --max-embedded-amount', () => {
    const policy = parseEmbeddedPolicy({
      autoEmbedded: true,
      maxEmbeddedAmount: '500000',
    });
    expect(policy).toEqual({ kind: 'auto', maxAmount: 500000n });
  });

  it('throws when --auto-embedded is set without --max-embedded-amount', () => {
    expect(() => parseEmbeddedPolicy({ autoEmbedded: true })).toThrow(
      /requires --max-embedded-amount/,
    );
  });

  it('throws when --max-embedded-amount is given without --auto-embedded', () => {
    expect(() =>
      parseEmbeddedPolicy({ maxEmbeddedAmount: '500000' }),
    ).toThrow(/requires --auto-embedded/);
  });

  it('rejects non-integer embedded amounts', () => {
    expect(() =>
      parseEmbeddedPolicy({
        autoEmbedded: true,
        maxEmbeddedAmount: '1.5',
      }),
    ).toThrow(/non-negative integer/);
  });

  it('falls back to "refuse" in --json mode', () => {
    const policy = parseEmbeddedPolicy({ json: true });
    expect(policy).toEqual({ kind: 'refuse' });
  });

  it('falls back to "refuse" in non-TTY stdin', () => {
    const original = process.stdin.isTTY;
    // Simulate pipe.
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      get: () => false,
    });
    try {
      const policy = parseEmbeddedPolicy({});
      expect(policy).toEqual({ kind: 'refuse' });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        get: () => original,
      });
    }
  });

  it('returns "prompt" when interactive and no flags are set', () => {
    const original = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      get: () => true,
    });
    try {
      const policy = parseEmbeddedPolicy({});
      expect(policy).toEqual({ kind: 'prompt' });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        get: () => original,
      });
    }
  });
});

// ─── confirmEmbeddedPayment ───────────────────────────────────────

describe('confirmEmbeddedPayment', () => {
  // Silence the pretty-print output while exercising policy logic.
  const originalLog = console.log;
  beforeEach(() => {
    console.log = vi.fn();
  });
  afterEach(() => {
    console.log = originalLog;
  });

  it('throws X402EmbeddedDeclinedError under the refuse policy', async () => {
    await expect(
      confirmEmbeddedPayment(challenge('120000000'), { kind: 'refuse' }, {
        json: true,
      }),
    ).rejects.toBeInstanceOf(X402EmbeddedDeclinedError);
  });

  it('approves silently under an auto policy within the ceiling', async () => {
    await expect(
      confirmEmbeddedPayment(
        challenge('120000'),
        { kind: 'auto', maxAmount: 500_000n },
        { json: true },
      ),
    ).resolves.toBeUndefined();
  });

  it('throws X402BudgetExceededError under an auto policy over the ceiling', async () => {
    const p = confirmEmbeddedPayment(
      challenge('600_000'.replace(/_/g, '')),
      { kind: 'auto', maxAmount: 500_000n },
      { json: true },
    );
    await expect(p).rejects.toBeInstanceOf(X402BudgetExceededError);
    await expect(p).rejects.toMatchObject({ scope: 'embedded' });
  });

  it('surfaces the scope=embedded marker so the error printer knows which flag to hint', async () => {
    try {
      await confirmEmbeddedPayment(
        challenge('600000'),
        { kind: 'auto', maxAmount: 500_000n },
        { json: true },
      );
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(X402BudgetExceededError);
      expect((err as X402BudgetExceededError).scope).toBe('embedded');
    }
  });
});
