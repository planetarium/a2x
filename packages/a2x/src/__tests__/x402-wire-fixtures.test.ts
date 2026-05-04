/**
 * Wire-format fixture regression tests (Q-19 decision).
 *
 * Each fixture is a snapshot of an A2A `Task` (or, for the submitted
 * fixture, a `Message`) at a specific point in the x402 lifecycle. The
 * tests assert that the SDK's read-side primitives interpret the
 * fixtures the same way they did before this epic — i.e. the wire
 * format is byte-equivalent across the surface refactor.
 *
 * If a future change accidentally renames a metadata key, drops a
 * receipt field, or changes a status string, these tests fail loudly
 * even though the higher-level executor tests still pass.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Task } from '../types/task.js';
import type { Message } from '../types/common.js';
import {
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
} from '../x402/constants.js';
import {
  getX402PaymentRequirements,
  getX402Receipts,
  getX402Status,
} from '../x402/client.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const FIXTURE_DIR = join(__dirname, '__fixtures__', 'x402-wire');

function readFixture<T>(name: string): T {
  const raw = readFileSync(join(FIXTURE_DIR, name), 'utf-8');
  return JSON.parse(raw) as T;
}

describe('x402 wire fixtures — read-side parsers', () => {
  it('payment-required fixture is recognised by getX402PaymentRequirements', () => {
    const task = readFixture<Task>('payment-required.json');
    const required = getX402PaymentRequirements(task);
    expect(required).toBeDefined();
    expect(required?.x402Version).toBe(1);
    expect(required?.accepts).toHaveLength(1);
    const accept = required!.accepts[0];
    expect(accept.network).toBe('base-sepolia');
    expect(accept.scheme).toBe('exact');
    expect(accept.maxAmountRequired).toBe('10000');
    expect(accept.resource).toBe('https://api.example.com/premium');
    expect(accept.description).toBe('Premium agent access');
    expect(accept.payTo).toBe('0x2222222222222222222222222222222222222222');
    expect(accept.asset).toBe('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
  });

  it('payment-submitted fixture carries the canonical metadata keys verbatim', () => {
    const message = readFixture<Message>('payment-submitted.json');
    expect(message.metadata?.[X402_METADATA_KEYS.STATUS]).toBe(
      X402_PAYMENT_STATUS.SUBMITTED,
    );
    const payload = message.metadata?.[X402_METADATA_KEYS.PAYLOAD] as {
      x402Version: number;
      network: string;
      scheme: string;
      payload: { authorization: { from: string; to: string; value: string } };
    };
    expect(payload.x402Version).toBe(1);
    expect(payload.network).toBe('base-sepolia');
    expect(payload.scheme).toBe('exact');
    expect(payload.payload.authorization.from).toBe(
      '0x1234567890123456789012345678901234567890',
    );
    expect(payload.payload.authorization.to).toBe(
      '0x2222222222222222222222222222222222222222',
    );
    expect(payload.payload.authorization.value).toBe('10000');
  });

  it('payment-completed fixture exposes status + receipts to the client primitives', () => {
    const task = readFixture<Task>('payment-completed.json');
    expect(getX402Status(task)).toBe(X402_PAYMENT_STATUS.COMPLETED);
    const receipts = getX402Receipts(task);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].success).toBe(true);
    expect(receipts[0].transaction).toBe('0xdeadbeef');
    expect(receipts[0].network).toBe('base-sepolia');
    expect(receipts[0].payer).toBe(
      '0x1234567890123456789012345678901234567890',
    );
  });

  it('payment-failed fixture preserves the failure code + receipt', () => {
    const task = readFixture<Task>('payment-failed.json');
    expect(getX402Status(task)).toBe(X402_PAYMENT_STATUS.FAILED);
    const meta = task.status.message?.metadata as Record<string, unknown>;
    expect(meta[X402_METADATA_KEYS.ERROR]).toBe('INVALID_SIGNATURE');
    const receipts = getX402Receipts(task);
    expect(receipts).toHaveLength(1);
    expect(receipts[0].success).toBe(false);
    expect(receipts[0].errorReason).toBe('invalid_signature');
  });
});
