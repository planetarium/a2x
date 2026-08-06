import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { TaskState, type Task } from '../types/task.js';
import {
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
} from '../x402/constants.js';
import {
  getX402BatchSettlementBinding,
  reconcileX402BatchSettlement,
  signX402Payment,
  type X402ClientChannelStorage,
} from '../x402/client.js';
import { X402NoSupportedRequirementError } from '../x402/errors.js';
import type { X402SettleResponse } from '../x402/types.js';

// The docs promise that `signX402Payment` hands the received envelope —
// including V2 `extensions`, which gate gas sponsoring in `@x402/evm` — to
// the signing runtime. That forwarding rests on an object spread that a
// field-by-field refactor could silently drop, so pin it here. The peer
// loader is mocked because the assertion is about what reaches
// `createPaymentPayload`, not about real signing (x402-client.test.ts covers
// that with the real peers, and `vi.mock` is file-scoped).
const captured: {
  envelope?: unknown;
  registered: [string, string][];
  batchOptions: Record<string, unknown>[];
  reconciled: { storage: unknown; settle: unknown }[];
  /** Makes the mocked peer throw for one channel id, as the real one would. */
  failOnChannelId?: string;
} = {
  registered: [],
  batchOptions: [],
  reconciled: [],
};

vi.mock('../x402/peer.js', () => ({
  importX402Peer: vi.fn(async (specifier: string) => {
    if (specifier === '@x402/core/client') {
      return {
        x402Client: class {
          register(network: string, scheme: { scheme: string }) {
            captured.registered.push([network, scheme.scheme]);
            return this;
          }
          async createPaymentPayload(envelope: unknown) {
            captured.envelope = envelope;
            const selected = (envelope as { accepts: { scheme: string }[] })
              .accepts[0]!;
            return {
              x402Version: 2,
              scheme: selected.scheme,
              network: 'eip155:84532',
              payload: {},
            };
          }
        },
      };
    }
    if (specifier === '@x402/evm/exact/client') {
      return { registerExactEvmScheme: (client: unknown) => client };
    }
    if (specifier === '@x402/evm/upto/client') {
      return {
        UptoEvmScheme: class {
          readonly scheme = 'upto';
        },
      };
    }
    if (specifier === '@x402/evm/batch-settlement/client') {
      return {
        BatchSettlementEvmScheme: class {
          readonly scheme = 'batch-settlement';
          constructor(_signer: unknown, options: unknown) {
            captured.batchOptions.push(options as Record<string, unknown>);
          }
        },
        processSettleResponse: async (storage: unknown, settle: unknown) => {
          const id = (
            (settle as { extra?: { channelState?: { channelId?: string } } })
              .extra?.channelState ?? {}
          ).channelId;
          if (captured.failOnChannelId && id === captured.failOnChannelId) {
            throw new Error('channel storage write failed');
          }
          captured.reconciled.push({ storage, settle });
        },
      };
    }
    throw new Error(`unexpected peer import: ${specifier}`);
  }),
}));

// `_loadRuntime` memoizes one runtime per signer identity, so every test that
// inspects scheme registration or a fresh envelope uses its own signer. Keys
// are padded counters — repeating a high hex digit 64 times overflows the
// secp256k1 group order.
function freshSigner(seed: number) {
  return privateKeyToAccount(
    `0x${seed.toString(16).padStart(64, '0')}` as `0x${string}`,
  );
}

const SIGNER = freshSigner(0x3333);

const V2_ACCEPT = {
  scheme: 'exact',
  network: 'eip155:84532',
  amount: '1000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x2222222222222222222222222222222222222222',
  maxTimeoutSeconds: 300,
  extra: { name: 'USDC', version: '2' },
};

const V2_UPTO_ACCEPT = {
  scheme: 'upto',
  network: 'eip155:84532',
  amount: '1000000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x2222222222222222222222222222222222222222',
  maxTimeoutSeconds: 300,
  extra: { facilitatorAddress: '0x4444444444444444444444444444444444444444' },
};

const V2_BATCH_ACCEPT = {
  scheme: 'batch-settlement',
  network: 'eip155:84532',
  amount: '3000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x2222222222222222222222222222222222222222',
  maxTimeoutSeconds: 300,
  extra: {
    receiverAuthorizer: '0x5555555555555555555555555555555555555555',
  },
};

const EXTENSIONS = { eip2612GasSponsoring: {}, erc20ApprovalGasSponsoring: {} };

/** Minimal `X402ClientChannelStorage` — identity is what the tests assert on. */
function memoryChannelStorage(): X402ClientChannelStorage {
  const channels = new Map<string, Record<string, unknown>>();
  return {
    get: async (key) => channels.get(key),
    set: async (key, state) => {
      channels.set(key, state);
    },
    delete: async (key) => {
      channels.delete(key);
    },
  };
}

function v2RequiredTask(accepts: unknown[] = [V2_ACCEPT]): Task {
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
            x402Version: 2,
            resource: { url: 'https://example.com/protected' },
            accepts,
            extensions: EXTENSIONS,
          },
        },
      },
    },
  };
}

describe('signX402Payment envelope forwarding', () => {
  it('hands the V2 extensions through to createPaymentPayload', async () => {
    const signed = await signX402Payment(v2RequiredTask(), { signer: SIGNER });

    const envelope = captured.envelope as {
      x402Version: number;
      accepts: unknown[];
      extensions?: unknown;
    };
    expect(envelope.extensions).toEqual(EXTENSIONS);
    // The envelope reaches the runtime narrowed to the selected requirement,
    // with everything else preserved.
    expect(envelope.x402Version).toBe(2);
    expect(envelope.accepts).toEqual([V2_ACCEPT]);
    expect(signed.metadata[X402_METADATA_KEYS.STATUS]).toBe(
      X402_PAYMENT_STATUS.SUBMITTED,
    );
  });

  it('registers the upto EVM scheme on the runtime alongside exact', async () => {
    captured.registered = [];
    await signX402Payment(v2RequiredTask(), { signer: freshSigner(0xa) });
    expect(captured.registered).toEqual([['eip155:*', 'upto']]);
  });
});

describe('signX402Payment upto selection policy', () => {
  it('refuses to auto-pick an upto offer without allowUpto', async () => {
    await expect(
      signX402Payment(v2RequiredTask([V2_UPTO_ACCEPT]), {
        signer: freshSigner(0xb),
      }),
    ).rejects.toThrow(X402NoSupportedRequirementError);
  });

  it('falls back to upto under allowUpto when no exact offer exists', async () => {
    const signed = await signX402Payment(v2RequiredTask([V2_UPTO_ACCEPT]), {
      signer: freshSigner(0xc),
      allowUpto: true,
    });
    expect(signed.requirement).toEqual(V2_UPTO_ACCEPT);
    expect(
      (captured.envelope as { accepts: unknown[] }).accepts,
    ).toEqual([V2_UPTO_ACCEPT]);
  });

  it('still prefers a payable exact offer when allowUpto is set', async () => {
    const signed = await signX402Payment(
      v2RequiredTask([V2_UPTO_ACCEPT, V2_ACCEPT]),
      { signer: freshSigner(0xd), allowUpto: true },
    );
    expect(signed.requirement).toEqual(V2_ACCEPT);
  });

  it('never falls back to a bare-name (V1) upto offer, even with allowUpto', async () => {
    // `upto` is V2-only; a bare-name network could only fail deep inside the
    // signing runtime, so the selector must not choose it at all.
    await expect(
      signX402Payment(
        v2RequiredTask([{ ...V2_UPTO_ACCEPT, network: 'base-sepolia' }]),
        { signer: freshSigner(0xf), allowUpto: true },
      ),
    ).rejects.toThrow(X402NoSupportedRequirementError);
  });

  it('throws when allowUpto is set but no EVM offer exists at all', async () => {
    await expect(
      signX402Payment(
        v2RequiredTask([{ ...V2_UPTO_ACCEPT, network: 'solana:mainnet' }]),
        { signer: freshSigner(0x9), allowUpto: true },
      ),
    ).rejects.toThrow(X402NoSupportedRequirementError);
  });

  it('signs an upto offer chosen by an explicit selectRequirement', async () => {
    const signed = await signX402Payment(
      v2RequiredTask([V2_ACCEPT, V2_UPTO_ACCEPT]),
      {
        signer: freshSigner(0xe),
        // No allowUpto — an explicit selector is the caller's own decision.
        selectRequirement: (reqs) => reqs.find((r) => r.scheme === 'upto'),
      },
    );
    expect(signed.requirement).toEqual(V2_UPTO_ACCEPT);
    expect(signed.payload.scheme).toBe('upto');
  });
});

describe('signX402Payment batch-settlement registration', () => {
  it('leaves the scheme unregistered when no batchSettlement config is given', async () => {
    captured.registered = [];
    await signX402Payment(v2RequiredTask(), { signer: freshSigner(0x11) });
    // Only `upto` — the batch scheme cannot be constructed from a signer
    // alone, so it is absent rather than defaulted to in-memory storage.
    expect(captured.registered).toEqual([['eip155:*', 'upto']]);
  });

  it('registers the scheme on the EVM wildcard when configured', async () => {
    captured.registered = [];
    captured.batchOptions = [];
    const storage = memoryChannelStorage();
    await signX402Payment(v2RequiredTask(), {
      signer: freshSigner(0x12),
      batchSettlement: { storage },
    });
    expect(captured.registered).toEqual([
      ['eip155:*', 'upto'],
      ['eip155:*', 'batch-settlement'],
    ]);
    // The caller's storage must reach the scheme by identity — a copy would
    // silently give the payer a second, empty channel record.
    expect(captured.batchOptions[0]!.storage).toBe(storage);
  });

  it('forwards only the tuning options the caller actually set', async () => {
    captured.batchOptions = [];
    await signX402Payment(v2RequiredTask(), {
      signer: freshSigner(0x13),
      batchSettlement: {
        storage: memoryChannelStorage(),
        depositPolicy: { depositMultiplier: 10 },
        salt: `0x${'ab'.repeat(32)}`,
      },
    });
    const options = captured.batchOptions[0]!;
    expect(options.depositPolicy).toEqual({ depositMultiplier: 10 });
    expect(options.salt).toBe(`0x${'ab'.repeat(32)}`);
    // Absent rather than explicitly undefined: `resolveClientOptions` reads
    // `rpcUrl` truthily but `isBatchSettlementEvmSchemeOptions` discriminates
    // on key *presence*, so passing undefined keys is not inert upstream.
    expect('rpcUrl' in options).toBe(false);
    expect('voucherSigner' in options).toBe(false);
    expect('payerAuthorizer' in options).toBe(false);
  });

  it('reuses one runtime per (signer, batchSettlement config) pair', async () => {
    const signer = freshSigner(0x14);
    const config = { storage: memoryChannelStorage() };
    captured.registered = [];
    await signX402Payment(v2RequiredTask(), { signer, batchSettlement: config });
    await signX402Payment(v2RequiredTask(), { signer, batchSettlement: config });
    expect(captured.registered).toHaveLength(2); // upto + batch, registered once

    // A different config for the same signer is a different runtime: the
    // scheme closes over the caller's storage, so sharing the cache slot
    // would point the second caller at the first caller's channels.
    captured.registered = [];
    await signX402Payment(v2RequiredTask(), {
      signer,
      batchSettlement: { storage: memoryChannelStorage() },
    });
    expect(captured.registered).toHaveLength(2);
  });
});

describe('signX402Payment batch-settlement selection policy', () => {
  it('refuses to auto-pick a batch-settlement offer without allowBatchSettlement', async () => {
    await expect(
      signX402Payment(v2RequiredTask([V2_BATCH_ACCEPT]), {
        signer: freshSigner(0x15),
        batchSettlement: { storage: memoryChannelStorage() },
      }),
    ).rejects.toThrow(X402NoSupportedRequirementError);
  });

  it('refuses to auto-pick it under allowBatchSettlement alone, with no storage configured', async () => {
    // Selecting a scheme that was never registered would fail deep inside
    // `createPaymentPayload`; the flag is inert without its config.
    await expect(
      signX402Payment(v2RequiredTask([V2_BATCH_ACCEPT]), {
        signer: freshSigner(0x16),
        allowBatchSettlement: true,
      }),
    ).rejects.toThrow(X402NoSupportedRequirementError);
  });

  it('falls back to batch-settlement when configured and opted in', async () => {
    const signed = await signX402Payment(v2RequiredTask([V2_BATCH_ACCEPT]), {
      signer: freshSigner(0x17),
      batchSettlement: { storage: memoryChannelStorage() },
      allowBatchSettlement: true,
    });
    expect(signed.requirement).toEqual(V2_BATCH_ACCEPT);
  });

  it('prefers exact, then upto, and takes batch-settlement last', async () => {
    // Widest consent loses: prepaying a channel moves money before any
    // service is rendered, so it only wins when nothing narrower is offered.
    const all = [V2_BATCH_ACCEPT, V2_UPTO_ACCEPT, V2_ACCEPT];
    const opts = {
      batchSettlement: { storage: memoryChannelStorage() },
      allowUpto: true,
      allowBatchSettlement: true,
    };

    const withExact = await signX402Payment(v2RequiredTask(all), {
      signer: freshSigner(0x18),
      ...opts,
    });
    expect(withExact.requirement).toEqual(V2_ACCEPT);

    const withoutExact = await signX402Payment(
      v2RequiredTask([V2_BATCH_ACCEPT, V2_UPTO_ACCEPT]),
      { signer: freshSigner(0x19), ...opts },
    );
    expect(withoutExact.requirement).toEqual(V2_UPTO_ACCEPT);
  });

  it('never falls back to a bare-name (V1) batch-settlement offer', async () => {
    // V2-only scheme, exactly like `upto` — a bare-name network could only
    // fail inside the signing runtime.
    await expect(
      signX402Payment(
        v2RequiredTask([{ ...V2_BATCH_ACCEPT, network: 'base-sepolia' }]),
        {
          signer: freshSigner(0x1a),
          batchSettlement: { storage: memoryChannelStorage() },
          allowBatchSettlement: true,
        },
      ),
    ).rejects.toThrow(X402NoSupportedRequirementError);
  });

  it('signs a batch-settlement offer chosen by an explicit selectRequirement', async () => {
    const signed = await signX402Payment(
      v2RequiredTask([V2_ACCEPT, V2_BATCH_ACCEPT]),
      {
        signer: freshSigner(0x1b),
        batchSettlement: { storage: memoryChannelStorage() },
        // No allowBatchSettlement — an explicit selector decides for itself.
        selectRequirement: (reqs) =>
          reqs.find((r) => r.scheme === 'batch-settlement'),
      },
    );
    expect(signed.requirement).toEqual(V2_BATCH_ACCEPT);
  });
});

describe('reconcileX402BatchSettlement', () => {
  const CHANNEL_A = `0x${'cd'.repeat(32)}`;
  const CHANNEL_B = `0x${'ef'.repeat(32)}`;
  const FOREIGN = `0x${'ab'.repeat(32)}`;
  // Ceilings the payer's vouchers authorized on each channel.
  const BIND_A = { channelId: CHANNEL_A, maxClaimableAmount: '3000' };
  const BIND_B = { channelId: CHANNEL_B, maxClaimableAmount: '6000' };

  const channelReceipt: X402SettleResponse = {
    success: true,
    // A successful voucher settlement carries no transaction hash — the
    // redeeming transaction happens later, out of band.
    transaction: '',
    network: 'eip155:84532',
    extra: {
      channelState: {
        channelId: CHANNEL_A,
        balance: '15000',
        totalClaimed: '0',
        chargedCumulativeAmount: '3000',
      },
    },
  };

  it('folds a voucher receipt into the caller storage', async () => {
    captured.reconciled = [];
    const storage = memoryChannelStorage();
    await reconcileX402BatchSettlement([channelReceipt], {
      storage,
      bindings: BIND_A,
    });
    expect(captured.reconciled).toHaveLength(1);
    expect(captured.reconciled[0]!.storage).toBe(storage);
    expect(captured.reconciled[0]!.settle).toBe(channelReceipt);
  });

  it('ignores a receipt naming a channel outside channelIds', async () => {
    // Channel ids are computable from public inputs, so a merchant this payer
    // *did* pay could otherwise name a channel belonging to a different
    // merchant and overwrite its cumulative — bricking it, or forcing an
    // invalid top-up.
    captured.reconciled = [];
    await reconcileX402BatchSettlement(
      [{ ...channelReceipt, extra: { channelState: { channelId: FOREIGN } } }],
      { storage: memoryChannelStorage(), bindings: BIND_A },
    );
    expect(captured.reconciled).toEqual([]);
  });

  it('matches the allowlist case-insensitively', async () => {
    // The peer lowercases the storage key, so a checksummed id from the
    // merchant must still match a lowercase one the payer signed.
    captured.reconciled = [];
    await reconcileX402BatchSettlement(
      [
        {
          ...channelReceipt,
          extra: {
            channelState: {
              channelId: CHANNEL_A.toUpperCase().replace('0X', '0x'),
              chargedCumulativeAmount: '3000',
            },
          },
        },
      ],
      { storage: memoryChannelStorage(), bindings: BIND_A },
    );
    expect(captured.reconciled).toHaveLength(1);
  });

  it('refuses a receipt that carries no cumulative to advance', async () => {
    // The peer writes only the keys it finds, so a receipt with just
    // `balance` / `totalClaimed` performs a partial write that leaves the
    // signing base where it was. Counting that as applied would mask the very
    // desync an empty `applied` exists to report.
    captured.reconciled = [];
    const { applied } = await reconcileX402BatchSettlement(
      [
        {
          ...channelReceipt,
          extra: {
            channelState: {
              channelId: CHANNEL_A,
              balance: '15000',
              totalClaimed: '0',
            },
          },
        },
        { ...channelReceipt, extra: { channelState: { channelId: CHANNEL_A } } },
      ],
      { storage: memoryChannelStorage(), bindings: BIND_A },
    );
    expect(applied).toEqual([]);
    expect(captured.reconciled).toEqual([]);
  });

  it('refuses a negative cumulative', async () => {
    captured.reconciled = [];
    const { applied } = await reconcileX402BatchSettlement(
      [
        {
          ...channelReceipt,
          extra: {
            channelState: { channelId: CHANNEL_A, chargedCumulativeAmount: '-1' },
          },
        },
      ],
      { storage: memoryChannelStorage(), bindings: BIND_A },
    );
    expect(applied).toEqual([]);
  });

  it('ignores receipts from other schemes without loading the peer', async () => {
    captured.reconciled = [];
    // An `exact` receipt has no channelState. Reconciling it would be a
    // no-op upstream anyway, but importing the peer to discover that would
    // make every non-batch payer pay for a module it never uses.
    await reconcileX402BatchSettlement(
      [{ success: true, transaction: '0xabc', network: 'eip155:84532' }],
      { storage: memoryChannelStorage(), bindings: BIND_A },
    );
    expect(captured.reconciled).toEqual([]);
  });

  it('skips failed receipts', async () => {
    captured.reconciled = [];
    await reconcileX402BatchSettlement(
      [{ ...channelReceipt, success: false, errorReason: 'CHANNEL_BUSY' }],
      { storage: memoryChannelStorage(), bindings: BIND_A },
    );
    expect(captured.reconciled).toEqual([]);
  });

  it('screens out a channelState with no canonical channelId', async () => {
    // The peer keys storage on `channelState.channelId.toLowerCase()` with no
    // guard of its own, so an unusable id would surface as a bare TypeError
    // thrown from inside `@x402/evm`. Requiring the canonical bytes32 form
    // also stops a near-miss id becoming a second, orphaned storage key.
    captured.reconciled = [];
    await reconcileX402BatchSettlement(
      [
        { ...channelReceipt, extra: { channelState: {} } },
        { ...channelReceipt, extra: { channelState: { channelId: 123 } } },
        { ...channelReceipt, extra: { channelState: { channelId: '' } } },
        { ...channelReceipt, extra: { channelState: null } },
        // Right length, missing 0x prefix.
        { ...channelReceipt, extra: { channelState: { channelId: 'cd'.repeat(32) } } },
        // Truncated.
        { ...channelReceipt, extra: { channelState: { channelId: '0xcd' } } },
      ],
      { storage: memoryChannelStorage(), bindings: BIND_A },
    );
    expect(captured.reconciled).toEqual([]);
  });

  it('still applies the good receipts when one fails, then reports', async () => {
    // Receipts are remote-controlled. One entry blowing up inside the peer
    // must not drop a later valid one — a receipt the payer never records
    // leaves it desynced, and `@x402/evm` cannot self-heal that without a
    // chain-reading signer.
    captured.reconciled = [];
    captured.failOnChannelId = CHANNEL_B;
    const poisoned: X402SettleResponse = {
      ...channelReceipt,
      extra: {
        channelState: {
          channelId: CHANNEL_B,
          chargedCumulativeAmount: '6000',
        },
      },
    };
    const storage = memoryChannelStorage();
    try {
      await expect(
        reconcileX402BatchSettlement([poisoned, channelReceipt], {
          storage,
          bindings: [BIND_A, BIND_B],
        }),
      ).rejects.toThrow(AggregateError);
      // The valid receipt after the failing one was still processed.
      expect(captured.reconciled.map((r) => r.settle)).toEqual([channelReceipt]);
    } finally {
      // Reset even on failure — a leaked value would break later tests in a
      // way that points at the wrong code.
      captured.failOnChannelId = undefined;
    }
  });

  it('processes every allowed channel receipt on a task, in order', async () => {
    captured.reconciled = [];
    const second: X402SettleResponse = {
      ...channelReceipt,
      extra: {
        channelState: { channelId: CHANNEL_B, chargedCumulativeAmount: '6000' },
      },
    };
    const { applied } = await reconcileX402BatchSettlement(
      [channelReceipt, second],
      { storage: memoryChannelStorage(), bindings: [BIND_A, BIND_B] },
    );
    // Compared by channel rather than object identity: a receipt whose
    // balance is below the floor is handed to the peer as a corrected copy.
    expect(applied).toEqual([CHANNEL_A, CHANNEL_B]);
    expect(
      captured.reconciled.map(
        (r) =>
          (r.settle as { extra: { channelState: { channelId: string } } }).extra
            .channelState.channelId,
      ),
    ).toEqual([CHANNEL_A, CHANNEL_B]);
  });
});

describe('reconcileX402BatchSettlement cumulative binding', () => {
  const CHANNEL = `0x${'cd'.repeat(32)}`;
  const binding = { channelId: CHANNEL, maxClaimableAmount: '3000' };

  function receiptWithCumulative(chargedCumulativeAmount: unknown) {
    return {
      success: true,
      transaction: '',
      network: 'eip155:84532',
      extra: { channelState: { channelId: CHANNEL, chargedCumulativeAmount } },
    } as X402SettleResponse;
  }

  it('refuses a cumulative above the ceiling the voucher authorized', async () => {
    // The concrete theft: after a 1000-unit voucher (cumulative ceiling 3000
    // here) the merchant reports 5000. Stored verbatim, the payer's next call
    // would sign a cumulative above it plus a top-up to cover the gap, letting
    // the merchant claim far more than the calls cost.
    captured.reconciled = [];
    const { applied } = await reconcileX402BatchSettlement(
      [receiptWithCumulative('5000')],
      { storage: memoryChannelStorage(), bindings: binding },
    );
    expect(applied).toEqual([]);
    expect(captured.reconciled).toEqual([]);
  });

  it('accepts a cumulative equal to the signed ceiling', async () => {
    captured.reconciled = [];
    const { applied } = await reconcileX402BatchSettlement(
      [receiptWithCumulative('3000')],
      { storage: memoryChannelStorage(), bindings: binding },
    );
    expect(applied).toEqual([CHANNEL]);
  });

  it('refuses a cumulative below the signed ceiling, including a stale local value', async () => {
    // Upstream verify requires signedMax === current + request amount and
    // settle advances by that same amount, so success reports the ceiling
    // exactly. Accepting an older value would let a historical receipt mask
    // this exchange while the merchant retains the higher-value voucher.
    const storage = memoryChannelStorage();
    await storage.set(CHANNEL.toLowerCase(), {
      chargedCumulativeAmount: '1000',
      balance: '5000',
    });
    captured.reconciled = [];
    const { applied } = await reconcileX402BatchSettlement(
      [receiptWithCumulative('1000')],
      { storage, bindings: binding },
    );
    expect(applied).toEqual([]);
    expect(captured.reconciled).toEqual([]);
    expect(await storage.get(CHANNEL.toLowerCase())).toMatchObject({
      chargedCumulativeAmount: '1000',
    });
  });

  it('refuses an unparseable cumulative', async () => {
    captured.reconciled = [];
    const { applied } = await reconcileX402BatchSettlement(
      [receiptWithCumulative('not-a-number'), receiptWithCumulative({})],
      { storage: memoryChannelStorage(), bindings: binding },
    );
    expect(applied).toEqual([]);
  });

  it('drops a binding whose ceiling cannot be parsed rather than unbounding it', async () => {
    captured.reconciled = [];
    const { applied } = await reconcileX402BatchSettlement(
      [receiptWithCumulative('1')],
      {
        storage: memoryChannelStorage(),
        bindings: { channelId: CHANNEL, maxClaimableAmount: 'oops' },
      },
    );
    expect(applied).toEqual([]);
  });
});

describe('reconcileX402BatchSettlement balance floor', () => {
  const CHANNEL = `0x${'cd'.repeat(32)}`;

  function receipt(balance: string) {
    return {
      success: true,
      transaction: '',
      network: 'eip155:84532',
      extra: {
        channelState: {
          channelId: CHANNEL,
          chargedCumulativeAmount: '1000',
          balance,
          totalClaimed: '0',
        },
      },
    } as X402SettleResponse;
  }

  function reportedBalance(): unknown {
    const settle = captured.reconciled.at(-1)!.settle as {
      extra: { channelState: Record<string, unknown> };
    };
    return settle.extra.channelState.balance;
  }

  // These assert what is handed to the peer. The state that actually lands in
  // storage — which depends on upstream's merge semantics — is covered in
  // `a2x-client-x402.test.ts` against the real `@x402/evm`.
  it('substitutes the floor for a balance below what this attempt funded', async () => {
    // The aggregate attack: `maxAmount` caps each deposit individually, so a
    // merchant reporting `balance: "0"` every round induces another
    // individually-capped deposit every round, unbounded in total. Within a
    // payment flow the balance only ever goes up, so anything below the floor
    // is a figure the merchant could not have reached honestly.
    captured.reconciled = [];
    await reconcileX402BatchSettlement([receipt('0')], {
      storage: memoryChannelStorage(),
      bindings: {
        channelId: CHANNEL,
        maxClaimableAmount: '1000',
        depositAmount: '5000',
      },
    });
    // Substituted, not deleted: the peer assigns `balance` only when the
    // receipt still carries the key, so dropping it would leave storage
    // holding the prior (here: absent) value.
    expect(captured.reconciled).toHaveLength(1);
    expect(reportedBalance()).toBe('5000');
    const state = (
      captured.reconciled[0]!.settle as {
        extra: { channelState: { chargedCumulativeAmount?: string } };
      }
    ).extra.channelState;
    expect(state.chargedCumulativeAmount).toBe('1000');
  });

  it('substitutes the floor when the merchant omits balance', async () => {
    captured.reconciled = [];
    await reconcileX402BatchSettlement(
      [
        {
          success: true,
          transaction: '',
          network: 'eip155:84532',
          extra: {
            channelState: {
              channelId: CHANNEL,
              chargedCumulativeAmount: '1000',
            },
          },
        } as X402SettleResponse,
      ],
      {
        storage: memoryChannelStorage(),
        bindings: {
          channelId: CHANNEL,
          maxClaimableAmount: '1000',
          depositAmount: '5000',
        },
      },
    );
    expect(reportedBalance()).toBe('5000');
  });

  it('keeps a balance at or above the floor', async () => {
    captured.reconciled = [];
    await reconcileX402BatchSettlement([receipt('5000')], {
      storage: memoryChannelStorage(),
      bindings: {
        channelId: CHANNEL,
        maxClaimableAmount: '1000',
        depositAmount: '5000',
      },
    });
    expect(reportedBalance()).toBe('5000');
  });

  it('adds the stored balance to the floor for a top-up', async () => {
    // Prior balance 5000 + this deposit 5000 = 10000. Reporting 5000 back
    // would hide the top-up and invite yet another one.
    const storage = memoryChannelStorage();
    await storage.set(CHANNEL.toLowerCase(), { balance: '5000' });
    captured.reconciled = [];
    await reconcileX402BatchSettlement([receipt('5000')], {
      storage,
      bindings: {
        channelId: CHANNEL,
        maxClaimableAmount: '1000',
        depositAmount: '5000',
      },
    });
    expect(reportedBalance()).toBe('10000');
  });

  it('keeps a balance above the floor untouched', async () => {
    // Overstating costs the payer nothing — it can only make the payer
    // under-fund later, and the merchant cannot claim funds never deposited.
    captured.reconciled = [];
    await reconcileX402BatchSettlement([receipt('999999')], {
      storage: memoryChannelStorage(),
      bindings: { channelId: CHANNEL, maxClaimableAmount: '1000' },
    });
    expect(reportedBalance()).toBe('999999');
  });
});

describe('getX402BatchSettlementBinding', () => {
  it('reads the binding off both payload shapes', () => {
    const id = `0x${'cd'.repeat(32)}`;
    // Voucher-only funds nothing, so there is no deposit floor to carry.
    expect(
      getX402BatchSettlementBinding({
        x402Version: 2,
        payload: {
          type: 'voucher',
          voucher: { channelId: id, maxClaimableAmount: '1000' },
        },
      } as unknown as Parameters<typeof getX402BatchSettlementBinding>[0]),
    ).toEqual({ channelId: id, maxClaimableAmount: '1000' });

    expect(
      getX402BatchSettlementBinding({
        x402Version: 2,
        payload: {
          type: 'deposit',
          voucher: { channelId: id, maxClaimableAmount: '1000' },
          deposit: { amount: '5000', authorization: {} },
        },
      } as unknown as Parameters<typeof getX402BatchSettlementBinding>[0]),
    ).toEqual({
      channelId: id,
      maxClaimableAmount: '1000',
      depositAmount: '5000',
    });
  });

  it('returns undefined for a payload of another scheme', () => {
    expect(
      getX402BatchSettlementBinding({
        x402Version: 2,
        payload: { authorization: { from: '0x1' }, signature: '0x2' },
      } as unknown as Parameters<typeof getX402BatchSettlementBinding>[0]),
    ).toBeUndefined();
  });

  it('returns undefined when either half is unusable', () => {
    const id = `0x${'cd'.repeat(32)}`;
    for (const voucher of [
      { channelId: '0xshort', maxClaimableAmount: '1000' },
      { channelId: id },
      { channelId: id, maxClaimableAmount: 1000 },
    ]) {
      expect(
        getX402BatchSettlementBinding({
          x402Version: 2,
          payload: { type: 'voucher', voucher },
        } as unknown as Parameters<typeof getX402BatchSettlementBinding>[0]),
      ).toBeUndefined();
    }
  });
});
