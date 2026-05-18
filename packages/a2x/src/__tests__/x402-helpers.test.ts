/**
 * Tests for the stateless x402 server-side helpers. Each helper is
 * exercised in isolation; the agent's composition of them is exercised
 * by the integration tests in the samples (`samples/nextjs-x402-*`).
 */
import { describe, expect, it } from 'vitest';
import type { Message } from '../types/common.js';
import {
  X402_ERROR_CODES,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
} from '../x402/constants.js';
import {
  buildX402PaymentCompletedMetadata,
  buildX402PaymentFailedMetadata,
  buildX402PaymentRequiredMetadata,
  buildX402PaymentVerifiedMetadata,
  normalizeX402Accept,
  parseX402PaymentSubmission,
  pickX402Requirement,
  validateX402PayloadShape,
  x402RequestPayment,
} from '../x402/payment.js';
import type {
  X402Accept,
  X402PaymentPayload,
  X402PaymentRequirements,
  X402SettleResponse,
} from '../x402/types.js';

const SAMPLE_ACCEPT: X402Accept = {
  network: 'base-sepolia',
  amount: '10000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x2222222222222222222222222222222222222222',
  resource: 'https://api.example.com/premium',
  description: 'Premium agent access',
};

const SAMPLE_REQUIREMENT: X402PaymentRequirements =
  normalizeX402Accept(SAMPLE_ACCEPT);

function buildSubmittedMessage(overrides: {
  status?: string;
  payTo?: string;
  value?: string;
  network?: string;
  scheme?: string;
} = {}): Message {
  const payload: X402PaymentPayload = {
    x402Version: 1,
    network: (overrides.network ?? 'base-sepolia') as X402PaymentPayload['network'],
    scheme: overrides.scheme ?? 'exact',
    payload: {
      signature: '0xabc',
      authorization: {
        from: '0x1234567890123456789012345678901234567890',
        to: overrides.payTo ?? SAMPLE_ACCEPT.payTo,
        value: overrides.value ?? '10000',
        validAfter: '0',
        validBefore: '9999999999',
        nonce: '0xnonce',
      },
    },
  } as X402PaymentPayload;
  return {
    messageId: 'm1',
    role: 'user',
    parts: [],
    metadata: {
      [X402_METADATA_KEYS.STATUS]: overrides.status ?? X402_PAYMENT_STATUS.SUBMITTED,
      [X402_METADATA_KEYS.PAYLOAD]: payload,
    },
  };
}

describe('normalizeX402Accept', () => {
  it('applies default scheme, mimeType, timeout, extra', () => {
    const req = normalizeX402Accept(SAMPLE_ACCEPT);
    expect(req.scheme).toBe('exact');
    expect(req.mimeType).toBe('application/json');
    expect(req.maxTimeoutSeconds).toBe(300);
    expect(req.extra).toEqual({ name: 'USDC', version: '2' });
    expect(req.maxAmountRequired).toBe('10000');
    expect(req.payTo).toBe(SAMPLE_ACCEPT.payTo);
    expect(req.resource).toBe(SAMPLE_ACCEPT.resource);
  });

  it('respects caller overrides', () => {
    const req = normalizeX402Accept({
      ...SAMPLE_ACCEPT,
      mimeType: 'application/octet-stream',
      maxTimeoutSeconds: 60,
      extra: { custom: true },
    });
    expect(req.mimeType).toBe('application/octet-stream');
    expect(req.maxTimeoutSeconds).toBe(60);
    expect(req.extra).toEqual({ custom: true });
  });
});

describe('buildX402PaymentRequiredMetadata', () => {
  it('produces the canonical payment-required metadata', () => {
    const md = buildX402PaymentRequiredMetadata({ accepts: [SAMPLE_ACCEPT] });
    expect(md[X402_METADATA_KEYS.STATUS]).toBe(X402_PAYMENT_STATUS.REQUIRED);
    const required = md[X402_METADATA_KEYS.REQUIRED] as {
      x402Version: number;
      accepts: X402PaymentRequirements[];
      error?: string;
    };
    expect(required.x402Version).toBe(1);
    expect(required.accepts).toHaveLength(1);
    expect(required.accepts[0]!.maxAmountRequired).toBe('10000');
    expect(required.error).toBeUndefined();
  });

  it('carries previousError into the required block', () => {
    const md = buildX402PaymentRequiredMetadata({
      accepts: [SAMPLE_ACCEPT],
      previousError: 'INSUFFICIENT_FUNDS',
    });
    const required = md[X402_METADATA_KEYS.REQUIRED] as { error?: string };
    expect(required.error).toBe('INSUFFICIENT_FUNDS');
  });

  it('throws when accepts is empty', () => {
    expect(() => buildX402PaymentRequiredMetadata({ accepts: [] })).toThrow(
      /at least one entry/,
    );
  });
});

describe('x402RequestPayment generator', () => {
  it('yields one request-input event with payment-required metadata', async () => {
    const events: unknown[] = [];
    for await (const event of x402RequestPayment({
      accepts: [SAMPLE_ACCEPT],
      description: 'Pay up',
    })) {
      events.push(event);
    }
    expect(events).toHaveLength(1);
    const ev = events[0] as {
      type: string;
      metadata: Record<string, unknown>;
      message?: string;
    };
    expect(ev.type).toBe('request-input');
    expect(ev.message).toBe('Pay up');
    expect(ev.metadata[X402_METADATA_KEYS.STATUS]).toBe(
      X402_PAYMENT_STATUS.REQUIRED,
    );
  });

  it('falls back to a default consent string when description is omitted', async () => {
    const events: unknown[] = [];
    for await (const ev of x402RequestPayment({ accepts: [SAMPLE_ACCEPT] })) {
      events.push(ev);
    }
    expect((events[0] as { message?: string }).message).toMatch(/payment/i);
  });
});

describe('parseX402PaymentSubmission', () => {
  it('returns undefined when the message has no x402 metadata', () => {
    expect(
      parseX402PaymentSubmission({
        messageId: 'm',
        role: 'user',
        parts: [{ text: 'hi' }],
      }),
    ).toBeUndefined();
  });

  it('extracts status, payload, and authorization', () => {
    const parsed = parseX402PaymentSubmission(buildSubmittedMessage());
    expect(parsed?.status).toBe(X402_PAYMENT_STATUS.SUBMITTED);
    expect(parsed?.payload).toBeDefined();
    expect(parsed?.authorization?.from).toBe(
      '0x1234567890123456789012345678901234567890',
    );
    expect(parsed?.authorization?.to).toBe(SAMPLE_ACCEPT.payTo);
  });

  it('returns a status-only submission when the client rejects payment', () => {
    const parsed = parseX402PaymentSubmission({
      messageId: 'm',
      role: 'user',
      parts: [],
      metadata: {
        [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REJECTED,
      },
    });
    expect(parsed?.status).toBe(X402_PAYMENT_STATUS.REJECTED);
    expect(parsed?.payload).toBeUndefined();
  });
});

describe('pickX402Requirement', () => {
  it('finds the requirement matching network + scheme', () => {
    const match = pickX402Requirement(
      buildSubmittedMessage().metadata![
        X402_METADATA_KEYS.PAYLOAD
      ] as X402PaymentPayload,
      [SAMPLE_REQUIREMENT],
    );
    expect(match).toBe(SAMPLE_REQUIREMENT);
  });

  it('returns undefined when the client picked an unadvertised network', () => {
    const payload = buildSubmittedMessage({ network: 'base' }).metadata![
      X402_METADATA_KEYS.PAYLOAD
    ] as X402PaymentPayload;
    expect(pickX402Requirement(payload, [SAMPLE_REQUIREMENT])).toBeUndefined();
  });
});

describe('validateX402PayloadShape', () => {
  it('returns an empty array for a clean payload', () => {
    const payload = buildSubmittedMessage().metadata![
      X402_METADATA_KEYS.PAYLOAD
    ] as X402PaymentPayload;
    expect(validateX402PayloadShape(payload, SAMPLE_REQUIREMENT)).toEqual([]);
  });

  it('flags payTo mismatch', () => {
    const payload = buildSubmittedMessage({
      payTo: '0xWRONGWRONGWRONGWRONGWRONGWRONGWRONGWRONG',
    }).metadata![X402_METADATA_KEYS.PAYLOAD] as X402PaymentPayload;
    const issues = validateX402PayloadShape(payload, SAMPLE_REQUIREMENT);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe(X402_ERROR_CODES.INVALID_PAY_TO);
  });

  it('flags amount over maxAmountRequired', () => {
    const payload = buildSubmittedMessage({ value: '99999999999' }).metadata![
      X402_METADATA_KEYS.PAYLOAD
    ] as X402PaymentPayload;
    const issues = validateX402PayloadShape(payload, SAMPLE_REQUIREMENT);
    expect(issues.some((i) => i.code === X402_ERROR_CODES.INVALID_AMOUNT)).toBe(
      true,
    );
  });

  it('accumulates multiple issues so caller can branch on each', () => {
    const payload = buildSubmittedMessage({
      payTo: '0xWRONG',
      value: '99999999999',
    }).metadata![X402_METADATA_KEYS.PAYLOAD] as X402PaymentPayload;
    const issues = validateX402PayloadShape(payload, SAMPLE_REQUIREMENT);
    expect(issues.length).toBeGreaterThanOrEqual(2);
    const codes = issues.map((i) => i.code);
    expect(codes).toContain(X402_ERROR_CODES.INVALID_PAY_TO);
    expect(codes).toContain(X402_ERROR_CODES.INVALID_AMOUNT);
  });

  it('flags non-EVM payloads as invalid (SDK supports EVM only today)', () => {
    const payload = {
      x402Version: 1,
      network: 'base-sepolia',
      scheme: 'exact',
      payload: { foo: 'bar' },
    } as unknown as X402PaymentPayload;
    const issues = validateX402PayloadShape(payload, SAMPLE_REQUIREMENT);
    expect(issues[0]!.code).toBe(X402_ERROR_CODES.INVALID_PAYLOAD);
  });
});

describe('buildX402PaymentCompletedMetadata', () => {
  const receipt: X402SettleResponse = {
    success: true,
    transaction: '0xtx',
    network: 'base-sepolia',
    payer: '0x1234567890123456789012345678901234567890',
  };

  it('produces completed status + the receipt', () => {
    const md = buildX402PaymentCompletedMetadata({ receipt });
    expect(md[X402_METADATA_KEYS.STATUS]).toBe(X402_PAYMENT_STATUS.COMPLETED);
    expect(md[X402_METADATA_KEYS.RECEIPTS]).toEqual([receipt]);
  });

  it('appends to priorReceipts in order', () => {
    const prior: X402SettleResponse = {
      success: false,
      transaction: '',
      network: 'base-sepolia',
      payer: '0x1234567890123456789012345678901234567890',
      errorReason: 'first-failure',
    };
    const md = buildX402PaymentCompletedMetadata({
      receipt,
      priorReceipts: [prior],
    });
    expect(md[X402_METADATA_KEYS.RECEIPTS]).toEqual([prior, receipt]);
  });
});

describe('buildX402PaymentFailedMetadata', () => {
  it('produces failed status + error code', () => {
    const md = buildX402PaymentFailedMetadata({
      code: X402_ERROR_CODES.INSUFFICIENT_FUNDS,
      reason: 'no funds',
    });
    expect(md[X402_METADATA_KEYS.STATUS]).toBe(X402_PAYMENT_STATUS.FAILED);
    expect(md[X402_METADATA_KEYS.ERROR]).toBe(
      X402_ERROR_CODES.INSUFFICIENT_FUNDS,
    );
    expect(md[X402_METADATA_KEYS.RECEIPTS]).toBeUndefined();
  });

  it('attaches the failure receipt and any prior receipts when provided', () => {
    const failure: X402SettleResponse = {
      success: false,
      transaction: '',
      network: 'base-sepolia',
      payer: '0x1234',
      errorReason: 'settle fail',
    };
    const prior: X402SettleResponse = {
      success: false,
      transaction: '',
      network: 'base-sepolia',
      payer: '0x1234',
      errorReason: 'earlier verify fail',
    };
    const md = buildX402PaymentFailedMetadata({
      code: X402_ERROR_CODES.SETTLEMENT_FAILED,
      reason: 'final failure',
      failureReceipt: failure,
      priorReceipts: [prior],
    });
    expect(md[X402_METADATA_KEYS.RECEIPTS]).toEqual([prior, failure]);
  });
});

describe('buildX402PaymentVerifiedMetadata', () => {
  it('produces the verified-state intermediate metadata', () => {
    expect(buildX402PaymentVerifiedMetadata()).toEqual({
      [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.VERIFIED,
    });
  });
});
