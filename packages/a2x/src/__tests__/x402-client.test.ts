import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { TaskState, type Task } from '../types/task.js';
import {
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
} from '../x402/constants.js';
import {
  X402InvalidVersionError,
  X402NoSupportedRequirementError,
  X402PaymentRequiredError,
} from '../x402/errors.js';
import {
  getX402PaymentExtensions,
  getX402PaymentRequirements,
  getX402Receipts,
  getX402Status,
  rejectX402Payment,
  signX402Payment,
  type X402ClientChannelStorage,
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

const BATCH_ACCEPT = {
  scheme: 'batch-settlement',
  network: 'eip155:84532',
  amount: '3000',
  asset: BASE_ACCEPT.asset,
  payTo: PAY_TO,
  maxTimeoutSeconds: 300,
  extra: {
    name: 'USDC',
    version: '2',
    receiverAuthorizer: '0x5555555555555555555555555555555555555555',
  },
};

function batchPaymentRequiredTask(): Task {
  return {
    id: 't-batch',
    contextId: 'c-batch',
    status: {
      state: TaskState.INPUT_REQUIRED,
      timestamp: new Date().toISOString(),
      message: {
        messageId: 'msg-batch',
        role: 'agent',
        parts: [{ text: 'pay from the channel' }],
        metadata: {
          [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
          [X402_METADATA_KEYS.REQUIRED]: {
            x402Version: 2,
            resource: { url: 'https://example.com/protected' },
            accepts: [BATCH_ACCEPT],
          },
        },
      },
    },
  };
}

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

describe('getX402PaymentExtensions', () => {
  function v2RequiredTask(extensions?: unknown): Task {
    const task = paymentRequiredTask([BASE_ACCEPT]);
    const meta = task.status.message!.metadata as Record<string, unknown>;
    meta[X402_METADATA_KEYS.REQUIRED] = {
      x402Version: 2,
      resource: { url: 'https://example.com/protected' },
      accepts: [],
      ...(extensions !== undefined ? { extensions } : {}),
    };
    return task;
  }

  it('returns the envelope-level extensions from a V2 payment-required task', () => {
    const extensions = { eip2612GasSponsoring: {}, erc20ApprovalGasSponsoring: {} };
    expect(getX402PaymentExtensions(v2RequiredTask(extensions))).toEqual(extensions);
  });

  it('returns undefined when the V2 envelope carries no extensions', () => {
    expect(getX402PaymentExtensions(v2RequiredTask())).toBeUndefined();
  });

  it('returns undefined for a V1 envelope — V1 has no extensions field', () => {
    expect(getX402PaymentExtensions(paymentRequiredTask([BASE_ACCEPT]))).toBeUndefined();
  });

  it('returns undefined for a nonconformant V1 envelope that smuggles extensions', () => {
    const task = paymentRequiredTask([BASE_ACCEPT]);
    const meta = task.status.message!.metadata as Record<string, unknown>;
    (meta[X402_METADATA_KEYS.REQUIRED] as Record<string, unknown>).extensions = {
      eip2612GasSponsoring: {},
    };
    expect(getX402PaymentExtensions(task)).toBeUndefined();
  });

  it.each([
    ['an array', ['eip2612GasSponsoring']],
    ['a string', 'eip2612GasSponsoring'],
    ['a number', 1],
    ['null', null],
  ])('returns undefined when the remote envelope carries %s instead of an object', (_label, hostile) => {
    expect(getX402PaymentExtensions(v2RequiredTask(hostile))).toBeUndefined();
  });

  it('returns undefined when the task is not asking for payment', () => {
    const task: Task = {
      id: 't1',
      status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
    };
    expect(getX402PaymentExtensions(task)).toBeUndefined();
  });
});

describe('getX402Status / getX402Receipts', () => {
  it('reads status and receipts from the final task message', () => {
    const receipt: X402SettleResponse = {
      success: true,
      transaction: '0xabc',
      network: 'base-sepolia',
      payer: '0x9999999999999999999999999999999999999999',
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

  it('signs a real V2 upto offer with the actual @x402/evm UptoEvmScheme', async () => {
    // The rest of the upto signing coverage mocks the peer; this one drives the
    // real runtime end to end. Signing is entirely local — a plain LocalAccount
    // exposes no `readContract`, so the gas-sponsoring extension paths bail out
    // before they would need an RPC endpoint.
    const facilitatorAddress = '0x4444444444444444444444444444444444444444';
    const uptoAccept = {
      scheme: 'upto',
      network: 'eip155:84532',
      asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
      amount: '1000000',
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { facilitatorAddress },
    };
    const task: Task = {
      id: 't1',
      contextId: 'c1',
      status: {
        state: TaskState.INPUT_REQUIRED,
        timestamp: new Date().toISOString(),
        message: {
          messageId: 'msg-upto',
          role: 'agent',
          parts: [{ text: 'pay up' }],
          metadata: {
            [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
            [X402_METADATA_KEYS.REQUIRED]: {
              x402Version: 2,
              resource: { url: 'https://example.com/protected' },
              accepts: [uptoAccept],
            },
          },
        },
      },
    };

    const signed = await signX402Payment(task, {
      signer: TEST_ACCOUNT,
      allowUpto: true,
    });

    expect(signed.requirement).toEqual(uptoAccept);
    const inner = signed.payload.payload as unknown as {
      signature: string;
      permit2Authorization: {
        from: string;
        permitted: { token: string; amount: string };
        witness: { to: string; facilitator: string };
      };
    };
    // A real secp256k1 signature, not a stub.
    expect(inner.signature).toMatch(/^0x[0-9a-f]{130}$/i);
    const auth = inner.permit2Authorization;
    expect(auth.from.toLowerCase()).toBe(TEST_ACCOUNT.address.toLowerCase());
    expect(auth.permitted.amount).toBe('1000000');
    expect(auth.permitted.token.toLowerCase()).toBe(uptoAccept.asset.toLowerCase());
    expect(auth.witness.to.toLowerCase()).toBe(PAY_TO.toLowerCase());
    expect(auth.witness.facilitator.toLowerCase()).toBe(facilitatorAddress);
    // The field names the SDK's validation and payer backfill depend on.
    expect(signed.payload).toHaveProperty('x402Version', 2);
  });

  it('binds the exact channel snapshot used by the real batch signer', async () => {
    // The peer reads storage to choose the voucher base. A later read is not
    // evidence of what was signed: another process may have changed the
    // record between the two calls.
    const signingSnapshot = {
      balance: '5000',
      chargedCumulativeAmount: '1000',
    };
    const laterState = {
      balance: '0',
      chargedCumulativeAmount: '1000',
    };
    let reads = 0;
    const storage: X402ClientChannelStorage = {
      get: async () => (++reads === 1 ? signingSnapshot : laterState),
      set: async () => {},
      delete: async () => {},
    };

    const signed = await signX402Payment(batchPaymentRequiredTask(), {
      signer: TEST_ACCOUNT,
      allowBatchSettlement: true,
      batchSettlement: { storage },
    });

    expect(signed.batch?.preAttemptState).toEqual(signingSnapshot);
  });

  it('isolates the signing snapshot from depositStrategy mutation', async () => {
    // Upstream exposes its clientContext to the strategy. If that object is
    // the storage-owned record, a strategy can mutate the reconciliation
    // basis after the signer has already computed its cumulative and balance.
    const storedState = {
      balance: '5000',
      chargedCumulativeAmount: '5000',
    };
    const expectedSnapshot = { ...storedState };
    const storage: X402ClientChannelStorage = {
      get: async () => storedState,
      set: async () => {},
      delete: async () => {},
    };

    const signed = await signX402Payment(batchPaymentRequiredTask(), {
      signer: privateKeyToAccount(
        '0x1211111111111111111111111111111111111111111111111111111111111111',
      ),
      allowBatchSettlement: true,
      batchSettlement: {
        storage,
        depositStrategy: (context) => {
          context.clientContext.balance = '0';
          return '5000';
        },
      },
    });

    expect(storedState).toEqual(expectedSnapshot);
    expect(signed.batch?.preAttemptState).toEqual(expectedSnapshot);
  });

  it('throws X402InvalidVersionError when the merchant claims a non-1 x402Version (spec §6/§9)', async () => {
    // x402-v1 §9 lists `invalid_x402_version`; the x402 npm package
    // pins `x402Versions: [1]`, so signing a non-1 requirement would
    // crash deep inside `createPaymentHeader`. We reject early so callers
    // see the spec error code.
    const task = paymentRequiredTask([BASE_ACCEPT]);
    const meta = task.status.message!.metadata as Record<string, unknown>;
    (meta[X402_METADATA_KEYS.REQUIRED] as { x402Version: number }).x402Version = 999;
    await expect(
      signX402Payment(task, { signer: TEST_ACCOUNT }),
    ).rejects.toBeInstanceOf(X402InvalidVersionError);
  });
});

describe('rejectX402Payment', () => {
  it('produces a payment-rejected metadata block from a payment-required task', () => {
    const task = paymentRequiredTask([BASE_ACCEPT]);
    const rejection = rejectX402Payment(task);
    expect(rejection.metadata[X402_METADATA_KEYS.STATUS]).toBe(
      X402_PAYMENT_STATUS.REJECTED,
    );
  });

  it('throws X402PaymentRequiredError when the task is not asking for payment', () => {
    const task: Task = {
      id: 't1',
      status: { state: TaskState.COMPLETED, timestamp: new Date().toISOString() },
    };
    expect(() => rejectX402Payment(task)).toThrowError(X402PaymentRequiredError);
  });
});
