/**
 * Server-side support for the x402 V2 `upto` scheme (usage-based payments).
 *
 * Covers the four seams that were `exact`-hardcoded: payload-shape validation,
 * metered settlement with the SDK-side clamp, `payer` backfill from the
 * Permit2 authorization, and the wire codecs' `extra` handling.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../types/common.js';
import {
  X402_ERROR_CODES,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
} from '../x402/constants.js';
import {
  InMemoryX402Store,
  X402Context,
  parseX402PaymentSubmission,
  validateX402PayloadShape,
  type X402ValidClassification,
} from '../x402/index.js';
import { encodeRequirementV1 } from '../x402/wire-v1.js';
import { encodeRequirementV2 } from '../x402/wire-v2.js';
import type {
  X402Accept,
  X402Facilitator,
  X402PaymentPayload,
  X402PaymentRequirements,
  X402Permit2Authorization,
} from '../x402/types.js';

const PAY_TO = '0x2222222222222222222222222222222222222222';
const ASSET = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const PAYER = '0x1234567890123456789012345678901234567890';
const FACILITATOR_ADDRESS = '0x4444444444444444444444444444444444444444';

/** Authorized maximum offered to the client (1 USDC in atomic units). */
const OFFERED = '1000000';

const UPTO_ACCEPT: X402Accept = {
  scheme: 'upto',
  network: 'eip155:84532',
  amount: OFFERED,
  asset: ASSET,
  payTo: PAY_TO,
  resource: 'https://api.example.com/tokens',
  description: 'Per-token LLM billing',
  extra: { facilitatorAddress: FACILITATOR_ADDRESS },
};

function permit2Authorization(
  overrides: Partial<{
    from: unknown;
    token: unknown;
    amount: unknown;
    to: unknown;
  }> = {},
): X402Permit2Authorization {
  return {
    from: (overrides.from ?? PAYER) as string,
    permitted: {
      token: (overrides.token ?? ASSET) as string,
      amount: (overrides.amount ?? OFFERED) as string,
    },
    spender: '0x5555555555555555555555555555555555555555',
    nonce: '0x01',
    deadline: '9999999999',
    witness: {
      to: (overrides.to ?? PAY_TO) as string,
      facilitator: FACILITATOR_ADDRESS,
      validAfter: '0',
    },
  };
}

function uptoPayload(
  overrides: Parameters<typeof permit2Authorization>[0] & {
    signature?: unknown;
    accepted?: X402PaymentRequirements;
  } = {},
): X402PaymentPayload {
  const { signature, accepted, ...authOverrides } = overrides;
  return {
    x402Version: 2,
    accepted: (accepted ?? encodeRequirementV2(UPTO_ACCEPT)) as never,
    payload: {
      ...(signature === null ? {} : { signature: signature ?? '0xsig' }),
      permit2Authorization: permit2Authorization(authOverrides),
    },
  } as X402PaymentPayload;
}

function submittedMessage(payload: X402PaymentPayload): Message {
  return {
    messageId: 'm1',
    role: 'user',
    parts: [],
    metadata: {
      [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.SUBMITTED,
      [X402_METADATA_KEYS.PAYLOAD]: payload,
    },
  };
}

// ─── Shape validation ───

describe('validateX402PayloadShape — upto', () => {
  const requirement = encodeRequirementV2(UPTO_ACCEPT);

  it('accepts a well-formed Permit2 payload', () => {
    expect(validateX402PayloadShape(uptoPayload(), requirement)).toEqual([]);
  });

  it('rejects a recipient the witness is not bound to', () => {
    const issues = validateX402PayloadShape(
      uptoPayload({ to: '0x9999999999999999999999999999999999999999' }),
      requirement,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe(X402_ERROR_CODES.INVALID_PAY_TO);
    expect(issues[0]!.reason).toContain('payTo mismatch');
  });

  it('rejects a token other than the offered asset', () => {
    const issues = validateX402PayloadShape(
      uptoPayload({ token: '0x8888888888888888888888888888888888888888' }),
      requirement,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe(X402_ERROR_CODES.INVALID_PAYLOAD);
    expect(issues[0]!.reason).toContain('asset mismatch');
  });

  it('rejects a zero authorization', () => {
    const issues = validateX402PayloadShape(
      uptoPayload({ amount: '0' }),
      requirement,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe(X402_ERROR_CODES.INVALID_AMOUNT);
    expect(issues[0]!.reason).toContain('greater than zero');
  });

  it('rejects an authorization above the offered maximum', () => {
    const issues = validateX402PayloadShape(
      uptoPayload({ amount: '1000001' }),
      requirement,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe(X402_ERROR_CODES.INVALID_AMOUNT);
    expect(issues[0]!.reason).toContain('exceeds maximum');
  });

  it('rejects a missing signature', () => {
    const issues = validateX402PayloadShape(
      uptoPayload({ signature: null }),
      requirement,
    );
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe(X402_ERROR_CODES.INVALID_SIGNATURE);
    expect(issues[0]!.reason).toContain('signature');
  });

  it('rejects a missing payer address', () => {
    const issues = validateX402PayloadShape(uptoPayload({ from: '' }), requirement);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.code).toBe(X402_ERROR_CODES.INVALID_PAYLOAD);
    expect(issues[0]!.reason).toContain('payer address');
  });

  it('does not report an EIP-3009 payload as "non-EVM"', () => {
    const exactShaped = {
      x402Version: 2,
      accepted: requirement,
      payload: {
        signature: '0xsig',
        authorization: {
          from: PAYER,
          to: PAY_TO,
          value: OFFERED,
          validAfter: '0',
          validBefore: '9',
          nonce: '0x1',
        },
      },
    } as unknown as X402PaymentPayload;
    const issues = validateX402PayloadShape(exactShaped, requirement);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.reason).toContain('permit2Authorization');
    expect(issues[0]!.reason).not.toContain('Non-EVM');
  });
});

describe('validateX402PayloadShape — exact path unchanged', () => {
  const exactRequirement = encodeRequirementV2({
    ...UPTO_ACCEPT,
    scheme: 'exact',
    extra: undefined,
  });

  function exactPayload(value: string, to = PAY_TO): X402PaymentPayload {
    return {
      x402Version: 2,
      accepted: exactRequirement,
      payload: {
        signature: '0xsig',
        authorization: {
          from: PAYER,
          to,
          value,
          validAfter: '0',
          validBefore: '9999999999',
          nonce: '0x1',
        },
      },
    } as unknown as X402PaymentPayload;
  }

  it('accepts a valid EIP-3009 authorization', () => {
    expect(validateX402PayloadShape(exactPayload(OFFERED), exactRequirement)).toEqual(
      [],
    );
  });

  it('still rejects an over-value authorization', () => {
    const issues = validateX402PayloadShape(
      exactPayload('1000001'),
      exactRequirement,
    );
    expect(issues[0]!.code).toBe(X402_ERROR_CODES.INVALID_AMOUNT);
  });

  it('reports a missing authorization against the exact scheme, not "non-EVM"', () => {
    const issues = validateX402PayloadShape(uptoPayload(), exactRequirement);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.reason).toContain('EIP-3009');
    expect(issues[0]!.reason).not.toContain('Non-EVM');
  });
});

// ─── classify + the overridable hook ───

async function offeredContext(
  facilitator: X402Facilitator,
  accept: X402Accept = UPTO_ACCEPT,
) {
  const x402 = new X402Context({
    facilitator,
    store: new InMemoryX402Store(),
    x402Version: 2,
  });
  const ctx = { taskId: 't-upto' };
  for await (const _ of x402.requestPayment(ctx, { accepts: [accept] })) {
    // drain
  }
  return x402;
}

function makeFacilitator(
  settle?: X402Facilitator['settle'],
): X402Facilitator & { seen: X402PaymentRequirements[] } {
  const seen: X402PaymentRequirements[] = [];
  return {
    seen,
    verify: vi.fn(async () => ({ isValid: true })),
    settle: vi.fn(async (payload, requirements) => {
      seen.push(requirements);
      return settle
        ? await settle(payload, requirements)
        : { success: true, transaction: '0xtx', network: 'eip155:84532' };
    }),
  };
}

describe('X402Context.classify — upto', () => {
  it('classifies a well-formed upto submission as valid', async () => {
    const facilitator = makeFacilitator();
    const x402 = await offeredContext(facilitator);
    const result = await x402.classify({
      taskId: 't-upto',
      message: submittedMessage(uptoPayload()),
    });
    expect(result.kind).toBe('valid');
    // Nothing was recorded as failed — the entry is still awaiting settlement.
    expect((await x402.store.get('t-upto'))!.status).toBe('offered');
  });

  it('records the classify failure only after the shape hook rejects', async () => {
    const facilitator = makeFacilitator();
    const x402 = await offeredContext(facilitator);
    const result = await x402.classify({
      taskId: 't-upto',
      message: submittedMessage(uptoPayload({ amount: '0' })),
    });
    expect(result.kind).toBe('invalid-shape');
    expect((await x402.store.get('t-upto'))!.status).toBe('failed');
  });

  it('lets a subclass override validatePayloadShape without repairing the store', async () => {
    class PermissiveContext extends X402Context {
      protected override validatePayloadShape() {
        return [];
      }
    }
    const x402 = new PermissiveContext({
      facilitator: makeFacilitator(),
      store: new InMemoryX402Store(),
      x402Version: 2,
    });
    const ctx = { taskId: 't-sub' };
    for await (const _ of x402.requestPayment(ctx, { accepts: [UPTO_ACCEPT] })) {
      // drain
    }
    // A payload the built-in validator would reject outright.
    const result = await x402.classify({
      taskId: 't-sub',
      message: submittedMessage(uptoPayload({ amount: '0', to: '0xdead' })),
    });
    expect(result.kind).toBe('valid');
    expect((await x402.store.get('t-sub'))!.status).toBe('offered');
    expect((await x402.store.get('t-sub'))!.failure).toBeUndefined();
  });
});

// ─── Metered settlement + clamp ───

async function classifiedUpto(
  x402: X402Context,
  payload: X402PaymentPayload = uptoPayload(),
): Promise<X402ValidClassification> {
  const result = await x402.classify({
    taskId: 't-upto',
    message: submittedMessage(payload),
  });
  if (result.kind !== 'valid') throw new Error(`expected valid, got ${result.kind}`);
  return result;
}

describe('X402Context.settle — metered amount', () => {
  it('forwards the metered amount on the requirement', async () => {
    const facilitator = makeFacilitator();
    const x402 = await offeredContext(facilitator);
    const classified = await classifiedUpto(x402);
    await x402.settle({ taskId: 't-upto' }, classified, { amountAtomic: '1234' });
    expect((facilitator.seen[0] as { amount: string }).amount).toBe('1234');
  });

  it('leaves the requirement untouched when no amount is metered', async () => {
    const facilitator = makeFacilitator();
    const x402 = await offeredContext(facilitator);
    const classified = await classifiedUpto(x402);
    await x402.settle({ taskId: 't-upto' }, classified);
    expect(facilitator.seen[0]).toBe(classified.requirement);
  });

  it('clamps down to the payer’s signed authorization cap', async () => {
    const facilitator = makeFacilitator();
    const x402 = await offeredContext(facilitator);
    // Payer authorized only 5000 of the 1000000 offered.
    const classified = await classifiedUpto(x402, uptoPayload({ amount: '5000' }));
    await x402.settle({ taskId: 't-upto' }, classified, { amountAtomic: '9000' });
    expect((facilitator.seen[0] as { amount: string }).amount).toBe('5000');
  });

  it('clamps down to the offered amount', async () => {
    const facilitator = makeFacilitator();
    const x402 = await offeredContext(facilitator);
    const classified = await classifiedUpto(x402);
    await x402.settle({ taskId: 't-upto' }, classified, {
      amountAtomic: '999999999',
    });
    expect((facilitator.seen[0] as { amount: string }).amount).toBe(OFFERED);
  });

  it('allows a zero metered charge', async () => {
    const facilitator = makeFacilitator();
    const x402 = await offeredContext(facilitator);
    const classified = await classifiedUpto(x402);
    await x402.settle({ taskId: 't-upto' }, classified, { amountAtomic: '0' });
    expect((facilitator.seen[0] as { amount: string }).amount).toBe('0');
  });

  it('is exact on 30+ digit atomic values (BigInt, not Number)', async () => {
    // Two values that are indistinguishable as IEEE-754 doubles.
    const cap = '1000000000000000000000000000001';
    const metered = '1000000000000000000000000000002';
    const big: X402Accept = { ...UPTO_ACCEPT, amount: metered };
    const facilitator = makeFacilitator();
    const x402 = await offeredContext(facilitator, big);
    const classified = await classifiedUpto(
      x402,
      uptoPayload({ amount: cap, accepted: encodeRequirementV2(big) }),
    );
    await x402.settle({ taskId: 't-upto' }, classified, { amountAtomic: metered });
    expect((facilitator.seen[0] as { amount: string }).amount).toBe(cap);
    expect(Number(cap) === Number(metered)).toBe(true); // the trap this guards
  });

  it('writes maxAmountRequired, not amount, on a V1 requirement', async () => {
    const facilitator = makeFacilitator();
    const x402 = new X402Context({
      facilitator,
      store: new InMemoryX402Store(),
      // V1 offering with an upto scheme — clamping must respect the V1 field.
      x402Version: 1,
    });
    const ctx = { taskId: 't-v1' };
    for await (const _ of x402.requestPayment(ctx, {
      accepts: [{ ...UPTO_ACCEPT, network: 'base-sepolia' }],
    })) {
      // drain
    }
    const v1Payload = {
      x402Version: 1,
      network: 'base-sepolia',
      scheme: 'upto',
      payload: { signature: '0xsig', permit2Authorization: permit2Authorization() },
    } as unknown as X402PaymentPayload;
    const result = await x402.classify({
      taskId: 't-v1',
      message: submittedMessage(v1Payload),
    });
    expect(result.kind).toBe('valid');
    await x402.settle({ taskId: 't-v1' }, result as X402ValidClassification, {
      amountAtomic: '777',
    });
    const seen = facilitator.seen[0] as {
      maxAmountRequired?: string;
      amount?: string;
    };
    expect(seen.maxAmountRequired).toBe('777');
    expect(seen.amount).toBeUndefined();
  });

  it('throws on a negative or unparseable metered amount', async () => {
    const facilitator = makeFacilitator();
    const x402 = await offeredContext(facilitator);
    const classified = await classifiedUpto(x402);
    await expect(
      x402.settle({ taskId: 't-upto' }, classified, { amountAtomic: '-1' }),
    ).rejects.toThrow(/must not be negative/);
    await expect(
      x402.settle({ taskId: 't-upto' }, classified, { amountAtomic: '1.5' }),
    ).rejects.toThrow(/integer string/);
  });
});

// ─── payer backfill + store receipt ───

describe('X402Context.settle — payer backfill and stored amount', () => {
  it('backfills payer from permit2Authorization.from when the facilitator omits it', async () => {
    const facilitator = makeFacilitator(async () => ({
      success: true,
      transaction: '0xtx',
      network: 'eip155:84532',
    }));
    const x402 = await offeredContext(facilitator);
    const classified = await classifiedUpto(x402);
    const receipt = await x402.settle({ taskId: 't-upto' }, classified, {
      amountAtomic: '4242',
    });
    expect(receipt.payer).toBe(PAYER);
  });

  it('backfills payer on the settle-exception failure receipt too', async () => {
    const facilitator = makeFacilitator(async () => {
      throw new Error('facilitator exploded');
    });
    const x402 = await offeredContext(facilitator);
    const classified = await classifiedUpto(x402);
    const receipt = await x402.settle({ taskId: 't-upto' }, classified);
    expect(receipt.success).toBe(false);
    expect(receipt.payer).toBe(PAYER);
  });

  it('exposes the payer on the parsed submission', () => {
    const submission = parseX402PaymentSubmission(submittedMessage(uptoPayload()));
    expect(submission!.payer).toBe(PAYER);
    expect(submission!.permit2Authorization!.permitted.amount).toBe(OFFERED);
    expect(submission!.authorization).toBeUndefined();
  });

  it('persists the settled amount on the store entry', async () => {
    const facilitator = makeFacilitator(async () => ({
      success: true,
      transaction: '0xtx',
      network: 'eip155:84532',
      amount: '4242',
    }));
    const x402 = await offeredContext(facilitator);
    const classified = await classifiedUpto(x402);
    await x402.settle({ taskId: 't-upto' }, classified, { amountAtomic: '4242' });
    const entry = await x402.store.get('t-upto');
    expect(entry!.status).toBe('completed');
    expect(entry!.receipt!.amount).toBe('4242');
    expect(entry!.receipt!.payer).toBe(PAYER);
  });

  it('falls back to the settled requirement amount when the facilitator omits it', async () => {
    const facilitator = makeFacilitator();
    const x402 = await offeredContext(facilitator);
    const classified = await classifiedUpto(x402);
    await x402.settle({ taskId: 't-upto' }, classified, { amountAtomic: '99' });
    expect((await x402.store.get('t-upto'))!.receipt!.amount).toBe('99');
  });
});

// ─── Wire codecs ───

describe('wire codecs — upto requirements', () => {
  it('round-trips an upto requirement with its facilitator extra intact (V2)', () => {
    const encoded = encodeRequirementV2(UPTO_ACCEPT);
    expect(encoded).toEqual({
      scheme: 'upto',
      network: 'eip155:84532',
      asset: ASSET,
      amount: OFFERED,
      payTo: PAY_TO,
      maxTimeoutSeconds: 300,
      extra: { facilitatorAddress: FACILITATOR_ADDRESS },
    });
  });

  it('round-trips an upto requirement under V1 too', () => {
    const encoded = encodeRequirementV1({
      ...UPTO_ACCEPT,
      network: 'base-sepolia',
    });
    expect(encoded.scheme).toBe('upto');
    expect(encoded.maxAmountRequired).toBe(OFFERED);
    expect(encoded.extra).toEqual({ facilitatorAddress: FACILITATOR_ADDRESS });
  });

  it('does not synthesize an EIP-712 domain for a non-exact scheme', () => {
    const { extra: _extra, ...withoutExtra } = UPTO_ACCEPT;
    expect(encodeRequirementV2(withoutExtra)).not.toHaveProperty('extra');
    expect(encodeRequirementV1(withoutExtra)).not.toHaveProperty('extra');
  });

  it('still defaults the EIP-712 domain for exact', () => {
    const { extra: _extra, ...withoutExtra } = UPTO_ACCEPT;
    expect(encodeRequirementV2({ ...withoutExtra, scheme: 'exact' }).extra).toEqual({
      name: 'USDC',
      version: '2',
    });
  });
});
