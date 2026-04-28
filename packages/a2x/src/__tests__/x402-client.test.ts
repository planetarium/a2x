import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { TaskState, type Task } from '../types/task.js';
import {
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
} from '../x402/constants.js';
import {
  X402NoSupportedRequirementError,
  X402PaymentRequiredError,
} from '../x402/errors.js';
import {
  getX402PaymentRequirements,
  getX402Receipts,
  getX402Status,
  signX402Payment,
} from '../x402/client.js';
import type {
  X402PaymentRequiredResponse,
  X402SettleResponse,
} from '../x402/types.js';

const TEST_ACCOUNT = privateKeyToAccount(
  '0x1111111111111111111111111111111111111111111111111111111111111111',
);
const PAY_TO = '0x2222222222222222222222222222222222222222';

function paymentRequiredTask(
  accepts: X402PaymentRequiredResponse['accepts'],
  error?: string,
): Task {
  return {
    id: 't1',
    contextId: 'c1',
    status: {
      state: TaskState.INPUT_REQUIRED,
      timestamp: new Date().toISOString(),
      message: {
        messageId: 'msg-x402',
        role: 'agent',
        parts: [{ text: 'Payment is required to use this service.' }],
        metadata: {
          [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
          [X402_METADATA_KEYS.REQUIRED]: {
            x402Version: 1,
            accepts,
            ...(error ? { error } : {}),
          } satisfies X402PaymentRequiredResponse,
        },
      },
    },
  };
}

const BASE_ACCEPT = {
  scheme: 'exact' as const,
  network: 'base-sepolia',
  maxAmountRequired: '1000',
  resource: 'https://example.com/protected',
  description: 'Test',
  mimeType: 'application/json',
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  extra: { name: 'USDC', version: '2' },
};

describe('getX402PaymentRequirements', () => {
  it('returns the X402PaymentRequiredResponse when the task is in payment-required', () => {
    const task = paymentRequiredTask([BASE_ACCEPT]);
    const required = getX402PaymentRequirements(task);
    expect(required).toBeDefined();
    expect(required?.x402Version).toBe(1);
    expect(required?.accepts).toHaveLength(1);
  });

  it('returns undefined when the task metadata has no x402 status', () => {
    const task: Task = {
      id: 't1',
      status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
    };
    expect(getX402PaymentRequirements(task)).toBeUndefined();
  });
});

describe('getX402Status / getX402Receipts', () => {
  it('reads status and receipts from the final task message', () => {
    const receipt: X402SettleResponse = {
      success: true,
      transaction: '0xabc',
      network: 'base-sepolia',
    };
    const task: Task = {
      id: 't1',
      status: {
        state: TaskState.COMPLETED,
        timestamp: new Date().toISOString(),
        message: {
          messageId: 'final',
          role: 'agent',
          parts: [{ text: 'ok' }],
          metadata: {
            [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.COMPLETED,
            [X402_METADATA_KEYS.RECEIPTS]: [receipt],
          },
        },
      },
    };
    expect(getX402Status(task)).toBe(X402_PAYMENT_STATUS.COMPLETED);
    expect(getX402Receipts(task)).toEqual([receipt]);
  });

  it('returns an empty receipts array when no x402 metadata is present', () => {
    const task: Task = {
      id: 't1',
      status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
    };
    expect(getX402Receipts(task)).toEqual([]);
  });
});

describe('signX402Payment', () => {
  it('produces a payment-submitted metadata block from a payment-required task', async () => {
    const task = paymentRequiredTask([BASE_ACCEPT]);
    const signed = await signX402Payment(task, { signer: TEST_ACCOUNT });

    expect(signed.requirement).toEqual(BASE_ACCEPT);
    expect(signed.metadata[X402_METADATA_KEYS.STATUS]).toBe(
      X402_PAYMENT_STATUS.SUBMITTED,
    );
    expect(signed.metadata[X402_METADATA_KEYS.PAYLOAD]).toEqual(signed.payload);
    expect(signed.payload.network).toBe('base-sepolia');
    expect(signed.payload.scheme).toBe('exact');
    const auth = (
      signed.payload.payload as unknown as { authorization: { from: string; to: string; value: string } }
    ).authorization;
    expect(auth.from.toLowerCase()).toBe(TEST_ACCOUNT.address.toLowerCase());
    expect(auth.to.toLowerCase()).toBe(PAY_TO.toLowerCase());
    expect(auth.value).toBe('1000');
  });

  it('uses a custom selectRequirement predicate', async () => {
    const cheap = { ...BASE_ACCEPT, maxAmountRequired: '100', description: 'cheap' };
    const expensive = { ...BASE_ACCEPT, maxAmountRequired: '1000000', description: 'expensive' };
    const task = paymentRequiredTask([cheap, expensive]);

    const signed = await signX402Payment(task, {
      signer: TEST_ACCOUNT,
      selectRequirement: (reqs) =>
        reqs.find((r) => r.description === 'expensive'),
    });

    expect(signed.requirement.description).toBe('expensive');
  });

  it('throws X402PaymentRequiredError when the task is not asking for payment', async () => {
    const task: Task = {
      id: 't1',
      status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
    };
    await expect(signX402Payment(task, { signer: TEST_ACCOUNT })).rejects.toBeInstanceOf(
      X402PaymentRequiredError,
    );
  });

  it('throws X402NoSupportedRequirementError when the selector returns nothing', async () => {
    const task = paymentRequiredTask([BASE_ACCEPT]);
    await expect(
      signX402Payment(task, {
        signer: TEST_ACCOUNT,
        selectRequirement: () => undefined,
      }),
    ).rejects.toBeInstanceOf(X402NoSupportedRequirementError);
  });
});
