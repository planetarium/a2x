/**
 * Tests for the high-level `X402Context` façade and the
 * `InMemoryX402Store` it ships by default. End-to-end agent runs are
 * exercised by the sample-driven tests; this file pins the unit
 * contract.
 */
import { describe, expect, it, vi } from 'vitest';
import type { Message } from '../types/common.js';
import {
  X402_ERROR_CODES,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
} from '../x402/constants.js';
import {
  BaseX402Context,
  BaseX402Store,
  InMemoryX402Store,
  X402Context,
  type X402StoreEntry,
} from '../x402/index.js';
import type {
  X402Accept,
  X402Facilitator,
  X402PaymentPayload,
} from '../x402/types.js';

const ACCEPT: X402Accept = {
  network: 'base-sepolia',
  amount: '10000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x2222222222222222222222222222222222222222',
  resource: 'https://api.example.com/premium',
  description: 'Premium agent access',
};

function buildSubmittedMessage(overrides: {
  status?: string;
  payTo?: string;
  value?: string;
  network?: string;
  scheme?: string;
  noPayload?: boolean;
} = {}): Message {
  const payload: X402PaymentPayload = {
    x402Version: 1,
    network: (overrides.network ?? 'base-sepolia') as X402PaymentPayload['network'],
    scheme: overrides.scheme ?? 'exact',
    payload: {
      signature: '0xabc',
      authorization: {
        from: '0x1234567890123456789012345678901234567890',
        to: overrides.payTo ?? ACCEPT.payTo,
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
      ...(overrides.noPayload ? {} : { [X402_METADATA_KEYS.PAYLOAD]: payload }),
    },
  };
}

function buildPlainMessage(): Message {
  return { messageId: 'm0', role: 'user', parts: [{ text: 'hi' }] };
}

function makeMockFacilitator(): X402Facilitator {
  return {
    verify: vi.fn(async () => ({ isValid: true } as Awaited<ReturnType<X402Facilitator['verify']>>)),
    settle: vi.fn(async () => ({
      success: true,
      transaction: '0xtx',
      network: 'base-sepolia',
      payer: '0xfacilitatorPayer',
    } as Awaited<ReturnType<X402Facilitator['settle']>>)),
  };
}

describe('InMemoryX402Store', () => {
  it('put / get round-trips an entry', async () => {
    const store = new InMemoryX402Store();
    const now = new Date();
    await store.put({ taskId: 't1', accepts: [ACCEPT], storedAt: now });
    const got = await store.get('t1');
    expect(got?.taskId).toBe('t1');
    expect(got?.accepts).toEqual([ACCEPT]);
  });

  it('returns undefined for absent taskId', async () => {
    expect(await new InMemoryX402Store().get('missing')).toBeUndefined();
  });

  it('lazily expires entries past expiresAt', async () => {
    const store = new InMemoryX402Store();
    const past = new Date(Date.now() - 1000);
    await store.put({ taskId: 't1', accepts: [ACCEPT], storedAt: past, expiresAt: past });
    expect(await store.get('t1')).toBeUndefined();
    // size() also reflects the purge.
    expect(store.size()).toBe(0);
  });

  it('delete removes the entry', async () => {
    const store = new InMemoryX402Store();
    await store.put({ taskId: 't1', accepts: [ACCEPT], storedAt: new Date() });
    await store.delete('t1');
    expect(await store.get('t1')).toBeUndefined();
  });

  it('evicts the least-recently-accessed entry when maxEntries is hit', async () => {
    const store = new InMemoryX402Store({ maxEntries: 2 });
    await store.put({ taskId: 'a', accepts: [ACCEPT], storedAt: new Date() });
    await store.put({ taskId: 'b', accepts: [ACCEPT], storedAt: new Date() });
    // Touch 'a' so 'b' becomes the LRU.
    await store.get('a');
    await store.put({ taskId: 'c', accepts: [ACCEPT], storedAt: new Date() });
    expect(await store.get('a')).toBeDefined();
    expect(await store.get('b')).toBeUndefined();
    expect(await store.get('c')).toBeDefined();
  });

  it('updates in place when put hits an existing taskId without evicting', async () => {
    const store = new InMemoryX402Store({ maxEntries: 1 });
    await store.put({ taskId: 't1', accepts: [ACCEPT], storedAt: new Date() });
    await store.put({
      taskId: 't1',
      accepts: [{ ...ACCEPT, amount: '99' }],
      storedAt: new Date(),
    });
    expect((await store.get('t1'))?.accepts[0]!.amount).toBe('99');
  });
});

describe('X402Context.requestPayment', () => {
  it('stores the offering and yields one request-input event', async () => {
    const facilitator = makeMockFacilitator();
    const ctx = new X402Context({ facilitator });

    const events: unknown[] = [];
    for await (const ev of ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT] })) {
      events.push(ev);
    }

    expect(events).toHaveLength(1);
    const ev = events[0] as { type: string; metadata: Record<string, unknown> };
    expect(ev.type).toBe('request-input');
    expect(ev.metadata[X402_METADATA_KEYS.STATUS]).toBe(
      X402_PAYMENT_STATUS.REQUIRED,
    );

    const stored = await ctx.store.get('t1');
    expect(stored?.accepts).toEqual([ACCEPT]);
  });

  it('writes status=offered on the new entry', async () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    await drain(ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT] }));
    const entry = await ctx.store.get('t1');
    expect(entry?.status).toBe('offered');
    expect(entry?.storedAt).toBeInstanceOf(Date);
    expect(entry?.updatedAt).toBeInstanceOf(Date);
    expect(entry?.verifiedAt).toBeUndefined();
    expect(entry?.receipt).toBeUndefined();
    expect(entry?.failure).toBeUndefined();
  });

  it('records expiresAt when expiresInSeconds is set', async () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    await drain(ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT], expiresInSeconds: 60 }));
    const entry = await ctx.store.get('t1');
    expect(entry?.expiresAt).toBeInstanceOf(Date);
    expect(entry!.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('throws when ctx.taskId is missing', async () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    await expect(drain(ctx.requestPayment({}, { accepts: [ACCEPT] }))).rejects.toThrow(
      /taskId is required/i,
    );
  });

  it('throws when accepts is empty', async () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    await expect(drain(ctx.requestPayment({ taskId: 't1' }, { accepts: [] }))).rejects.toThrow(
      /at least one entry/,
    );
  });
});

describe('X402Context.classify', () => {
  it('returns no-submission when the incoming message has no x402 fields', async () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    const result = await ctx.classify({ taskId: 't1', message: buildPlainMessage() });
    expect(result.kind).toBe('no-submission');
  });

  it('returns no-submission when the message is omitted', async () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    const result = await ctx.classify({ taskId: 't1' });
    expect(result.kind).toBe('no-submission');
  });

  it('returns rejected when the client sends payment-rejected', async () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    const result = await ctx.classify({
      taskId: 't1',
      message: buildSubmittedMessage({ status: X402_PAYMENT_STATUS.REJECTED, noPayload: true }),
    });
    expect(result.kind).toBe('rejected');
  });

  it('returns no-stored-offering when there is no record for the taskId', async () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    const result = await ctx.classify({ taskId: 't-unknown', message: buildSubmittedMessage() });
    expect(result.kind).toBe('no-stored-offering');
  });

  it('returns no-stored-offering when payload is missing', async () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    await drain(ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT] }));
    const result = await ctx.classify({
      taskId: 't1',
      message: buildSubmittedMessage({ noPayload: true }),
    });
    expect(result.kind).toBe('no-stored-offering');
    if (result.kind === 'no-stored-offering') {
      expect(result.code).toBe(X402_ERROR_CODES.INVALID_PAYLOAD);
    }
  });

  it('returns unmatched when the submitted network/scheme is not in the offering', async () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    await drain(ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT] }));
    const result = await ctx.classify({
      taskId: 't1',
      message: buildSubmittedMessage({ network: 'base' }),
    });
    expect(result.kind).toBe('unmatched');
    if (result.kind === 'unmatched') {
      expect(result.code).toBe(X402_ERROR_CODES.NETWORK_MISMATCH);
    }
  });

  it('returns invalid-shape when payTo / amount do not match the requirement', async () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    await drain(ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT] }));
    const result = await ctx.classify({
      taskId: 't1',
      message: buildSubmittedMessage({ payTo: '0xWRONG' }),
    });
    expect(result.kind).toBe('invalid-shape');
    if (result.kind === 'invalid-shape') {
      expect(result.issues.length).toBeGreaterThan(0);
      expect(result.code).toBe(result.issues[0]!.code);
    }
  });

  it('records failure with point=rejected-by-client on rejected', async () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    await drain(ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT] }));
    await ctx.classify({
      taskId: 't1',
      message: buildSubmittedMessage({ status: X402_PAYMENT_STATUS.REJECTED, noPayload: true }),
    });
    const entry = await ctx.store.get('t1');
    expect(entry?.status).toBe('rejected');
    expect(entry?.failure?.point).toBe('rejected-by-client');
  });

  it('records failure with point=classify on unmatched', async () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    await drain(ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT] }));
    await ctx.classify({
      taskId: 't1',
      message: buildSubmittedMessage({ network: 'base' }),
    });
    const entry = await ctx.store.get('t1');
    expect(entry?.status).toBe('failed');
    expect(entry?.failure?.point).toBe('classify');
    expect(entry?.failure?.code).toBe(X402_ERROR_CODES.NETWORK_MISMATCH);
  });

  it('records failure with point=classify on invalid-shape', async () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    await drain(ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT] }));
    await ctx.classify({
      taskId: 't1',
      message: buildSubmittedMessage({ payTo: '0xWRONG' }),
    });
    const entry = await ctx.store.get('t1');
    expect(entry?.status).toBe('failed');
    expect(entry?.failure?.point).toBe('classify');
  });

  it('returns valid for a well-formed matching submission', async () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    await drain(ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT] }));
    const result = await ctx.classify({
      taskId: 't1',
      message: buildSubmittedMessage(),
    });
    expect(result.kind).toBe('valid');
    if (result.kind === 'valid') {
      expect(result.requirement.payTo).toBe(ACCEPT.payTo);
    }
  });

  it('throws when ctx.taskId is missing on a submitted message', async () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    await expect(
      ctx.classify({ message: buildSubmittedMessage() }),
    ).rejects.toThrow(/taskId is required/i);
  });
});

describe('X402Context.verify and X402Context.settle', () => {
  it('verify forwards to facilitator.verify and records status=verified', async () => {
    const facilitator = makeMockFacilitator();
    const ctx = new X402Context({ facilitator });
    await drain(ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT] }));
    const classified = await ctx.classify({
      taskId: 't1',
      message: buildSubmittedMessage(),
    });
    if (classified.kind !== 'valid') throw new Error('expected valid');
    await ctx.verify({ taskId: 't1' }, classified);
    expect(facilitator.verify).toHaveBeenCalledTimes(1);
    const entry = await ctx.store.get('t1');
    expect(entry?.status).toBe('verified');
    expect(entry?.verifiedAt).toBeInstanceOf(Date);
  });

  it('verify records failure with point=verify when facilitator returns isValid=false', async () => {
    const facilitator: X402Facilitator = {
      verify: vi.fn(async () => ({
        isValid: false,
        invalidReason: 'insufficient_funds',
      } as Awaited<ReturnType<X402Facilitator['verify']>>)),
      settle: vi.fn(async () => ({
        success: true,
        transaction: '0xtx',
        network: 'base-sepolia',
        payer: '0xmock',
      } as Awaited<ReturnType<X402Facilitator['settle']>>)),
    };
    const ctx = new X402Context({ facilitator });
    await drain(ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT] }));
    const classified = await ctx.classify({
      taskId: 't1',
      message: buildSubmittedMessage(),
    });
    if (classified.kind !== 'valid') throw new Error('expected valid');
    await ctx.verify({ taskId: 't1' }, classified);
    const entry = await ctx.store.get('t1');
    expect(entry?.status).toBe('failed');
    expect(entry?.failure?.point).toBe('verify');
    expect(entry?.failure?.code).toBe(X402_ERROR_CODES.INSUFFICIENT_FUNDS);
  });

  it('settle returns a wire-conformant X402SettleResponse and records status=completed + receipt', async () => {
    // Facilitator returns no payer — settle must fall back to authorization.from.
    const facilitator: X402Facilitator = {
      verify: vi.fn(async () => ({ isValid: true } as Awaited<ReturnType<X402Facilitator['verify']>>)),
      settle: vi.fn(async () => ({
        success: true,
        transaction: '0xtx',
        network: 'base-sepolia',
      } as Awaited<ReturnType<X402Facilitator['settle']>>)),
    };
    const ctx = new X402Context({ facilitator });
    await drain(ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT] }));
    const classified = await ctx.classify({
      taskId: 't1',
      message: buildSubmittedMessage(),
    });
    if (classified.kind !== 'valid') throw new Error('expected valid');
    const receipt = await ctx.settle({ taskId: 't1' }, classified);
    expect(receipt.success).toBe(true);
    expect(receipt.transaction).toBe('0xtx');
    expect(receipt.network).toBe('base-sepolia');
    // Fallback to authorization.from since facilitator omitted payer.
    expect(receipt.payer).toBe('0x1234567890123456789012345678901234567890');

    const entry = await ctx.store.get('t1');
    expect(entry?.status).toBe('completed');
    expect(entry?.receipt?.transaction).toBe('0xtx');
    expect(entry?.receipt?.payer).toBe('0x1234567890123456789012345678901234567890');
    expect(entry?.receipt?.settledAt).toBeInstanceOf(Date);
  });

  it('settle records failure with point=settle when facilitator returns success=false', async () => {
    const facilitator: X402Facilitator = {
      verify: vi.fn(async () => ({ isValid: true } as Awaited<ReturnType<X402Facilitator['verify']>>)),
      settle: vi.fn(async () => ({
        success: false,
        transaction: '',
        network: 'base-sepolia',
        errorReason: 'on-chain reverted',
      } as Awaited<ReturnType<X402Facilitator['settle']>>)),
    };
    const ctx = new X402Context({ facilitator });
    await drain(ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT] }));
    const classified = await ctx.classify({
      taskId: 't1',
      message: buildSubmittedMessage(),
    });
    if (classified.kind !== 'valid') throw new Error('expected valid');
    const receipt = await ctx.settle({ taskId: 't1' }, classified);
    expect(receipt.success).toBe(false);
    const entry = await ctx.store.get('t1');
    expect(entry?.status).toBe('failed');
    expect(entry?.failure?.point).toBe('settle');
    expect(entry?.failure?.code).toBe(X402_ERROR_CODES.SETTLEMENT_FAILED);
    expect(entry?.failure?.reason).toContain('on-chain reverted');
  });
});

describe('X402Context.failedEvent / completedEvent / clearOffering', () => {
  it('failedEvent builds an error event with failed metadata', () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    const ev = ctx.failedEvent({ code: X402_ERROR_CODES.INSUFFICIENT_FUNDS, reason: 'broke' });
    expect(ev.type).toBe('error');
    if (ev.type === 'error') {
      expect(ev.error.message).toBe('broke');
      expect(ev.metadata?.[X402_METADATA_KEYS.STATUS]).toBe(X402_PAYMENT_STATUS.FAILED);
      expect(ev.metadata?.[X402_METADATA_KEYS.ERROR]).toBe(X402_ERROR_CODES.INSUFFICIENT_FUNDS);
    }
  });

  it('completedEvent builds a done event with completed metadata', () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    const ev = ctx.completedEvent({
      receipt: { success: true, transaction: '0xtx', network: 'base-sepolia', payer: '0x1' },
    });
    expect(ev.type).toBe('done');
    if (ev.type === 'done') {
      expect(ev.metadata?.[X402_METADATA_KEYS.STATUS]).toBe(X402_PAYMENT_STATUS.COMPLETED);
      const receipts = ev.metadata?.[X402_METADATA_KEYS.RECEIPTS] as Array<{ payer: string }>;
      expect(receipts).toHaveLength(1);
      expect(receipts[0]!.payer).toBe('0x1');
    }
  });

  it('clearOffering removes the stored entry', async () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    await drain(ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT] }));
    await ctx.clearOffering({ taskId: 't1' });
    expect(await ctx.store.get('t1')).toBeUndefined();
  });

  it('clearOffering is a no-op when ctx.taskId is missing', async () => {
    const ctx = new X402Context({ facilitator: makeMockFacilitator() });
    await expect(ctx.clearOffering({})).resolves.toBeUndefined();
  });
});

describe('BaseX402Context subclassing', () => {
  it('subclass overriding verify gets called via the standard pipeline', async () => {
    let overrideCalled = 0;
    class LoggingContext extends BaseX402Context {
      readonly store = new InMemoryX402Store();
      readonly facilitator = makeMockFacilitator();

      async verify(
        ctx: Parameters<BaseX402Context['verify']>[0],
        classified: Parameters<BaseX402Context['verify']>[1],
      ) {
        overrideCalled += 1;
        return super.verify(ctx, classified);
      }
    }
    const ctx = new LoggingContext();
    await drain(ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT] }));
    const classified = await ctx.classify({
      taskId: 't1',
      message: buildSubmittedMessage(),
    });
    if (classified.kind !== 'valid') throw new Error('expected valid');
    await ctx.verify({ taskId: 't1' }, classified);
    expect(overrideCalled).toBe(1);
  });

  it('subclass with a custom store + custom facilitator instantiates without options', async () => {
    class TightContext extends BaseX402Context {
      readonly store = new InMemoryX402Store({ maxEntries: 8 });
      readonly facilitator = makeMockFacilitator();
    }
    const ctx = new TightContext();
    // The full classify pipeline works against the subclass-provided
    // store without going through the X402Context default wiring.
    await drain(ctx.requestPayment({ taskId: 't-tight' }, { accepts: [ACCEPT] }));
    const result = await ctx.classify({
      taskId: 't-tight',
      message: buildSubmittedMessage(),
    });
    expect(result.kind).toBe('valid');
  });
});

describe('X402Context custom store', () => {
  it('uses the provided BaseX402Store subclass implementation', async () => {
    const calls: { method: string; arg: unknown }[] = [];
    class RecordingStore extends BaseX402Store {
      async put(entry: X402StoreEntry) {
        calls.push({ method: 'put', arg: entry });
      }
      async get(taskId: string) {
        calls.push({ method: 'get', arg: taskId });
        return undefined;
      }
      async update(taskId: string, patch: unknown) {
        calls.push({ method: 'update', arg: { taskId, patch } });
      }
      async delete(taskId: string) {
        calls.push({ method: 'delete', arg: taskId });
      }
    }
    const store = new RecordingStore();
    const ctx = new X402Context({ store, facilitator: makeMockFacilitator() });
    await drain(ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT] }));
    await ctx.clearOffering({ taskId: 't1' });
    expect(calls.map((c) => c.method)).toEqual(['put', 'delete']);
  });
});

async function drain<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of iter) out.push(x);
  return out;
}
