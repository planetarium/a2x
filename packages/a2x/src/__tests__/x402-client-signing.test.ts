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
  type X402BatchSettlementBinding,
  type X402ClientChannelStorage,
} from '../x402/client.js';
import {
  X402ChannelQuarantinedError,
  X402NoSupportedRequirementError,
  X402PaymentRequiredError,
} from '../x402/errors.js';
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
  uptoOptions: unknown[];
} = {
  registered: [],
  batchOptions: [],
  uptoOptions: [],
};

/** Channel id the mocked batch-settlement runtime signs vouchers against. */
const MOCK_BATCH_CHANNEL = `0x${'aa'.repeat(32)}`;

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
              // A batch payload carries the voucher the binding is read from;
              // every other scheme's payload shape is irrelevant to these
              // tests.
              payload:
                selected.scheme === 'batch-settlement'
                  ? {
                      type: 'voucher',
                      voucher: {
                        channelId: MOCK_BATCH_CHANNEL,
                        maxClaimableAmount: '3000',
                      },
                    }
                  : {},
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
          constructor(_signer: unknown, options?: unknown) {
            captured.uptoOptions.push(options);
          }
        },
      };
    }
    if (specifier === '@x402/evm/batch-settlement/client') {
      return {
        BatchSettlementEvmScheme: class {
          readonly scheme = 'batch-settlement';
          constructor(_signer: unknown, options: unknown) {
            const multiplier = (
              options as { depositPolicy?: { depositMultiplier?: number } }
            ).depositPolicy?.depositMultiplier;
            if (multiplier !== undefined && multiplier < 3) {
              throw new Error('depositMultiplier must be an integer >= 3');
            }
            captured.batchOptions.push(options as Record<string, unknown>);
          }
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

describe('signX402Payment upto payer configuration', () => {
  it('forwards the upto RPC config to the UptoEvmScheme constructor', async () => {
    captured.uptoOptions = [];
    await signX402Payment(v2RequiredTask([V2_UPTO_ACCEPT]), {
      signer: freshSigner(0x21),
      allowUpto: true,
      upto: { rpcUrl: 'https://rpc.example' },
    });
    expect(captured.uptoOptions).toEqual([{ rpcUrl: 'https://rpc.example' }]);
  });

  it('passes no options when the caller configured none', async () => {
    captured.uptoOptions = [];
    await signX402Payment(v2RequiredTask([V2_UPTO_ACCEPT]), {
      signer: freshSigner(0x22),
      allowUpto: true,
    });
    expect(captured.uptoOptions).toEqual([undefined]);
  });

  it('supports the per-chain-id config shape', async () => {
    captured.uptoOptions = [];
    await signX402Payment(v2RequiredTask([V2_UPTO_ACCEPT]), {
      signer: freshSigner(0x23),
      allowUpto: true,
      upto: { 84532: { rpcUrl: 'https://rpc.example/84532' } },
    });
    expect(captured.uptoOptions).toEqual([
      { 84532: { rpcUrl: 'https://rpc.example/84532' } },
    ]);
  });

  it('never serves a runtime built with a different upto config from the cache', async () => {
    // The per-signer cache memoizes only the configless runtime. A signer
    // that signed without upto config, then with one, then with another must
    // get a runtime constructed with each configuration it asked for.
    const signer = freshSigner(0x24);
    captured.uptoOptions = [];
    await signX402Payment(v2RequiredTask([V2_UPTO_ACCEPT]), {
      signer,
      allowUpto: true,
    });
    await signX402Payment(v2RequiredTask([V2_UPTO_ACCEPT]), {
      signer,
      allowUpto: true,
      upto: { rpcUrl: 'https://rpc.example/a' },
    });
    await signX402Payment(v2RequiredTask([V2_UPTO_ACCEPT]), {
      signer,
      allowUpto: true,
      upto: { rpcUrl: 'https://rpc.example/b' },
    });
    expect(captured.uptoOptions).toEqual([
      undefined,
      { rpcUrl: 'https://rpc.example/a' },
      { rpcUrl: 'https://rpc.example/b' },
    ]);
  });

  it('rides along when a batch-settlement requirement builds the runtime', async () => {
    // Selecting batch-settlement builds the runtime through its own branch
    // (the signing-read recorder path); the upto config must reach the
    // scheme constructor there too.
    captured.uptoOptions = [];
    await signX402Payment(v2RequiredTask([V2_BATCH_ACCEPT]), {
      signer: freshSigner(0x25),
      upto: { rpcUrl: 'https://rpc.example/with-batch' },
      batchSettlement: { storage: memoryChannelStorage() },
      allowBatchSettlement: true,
    });
    expect(captured.uptoOptions).toEqual([
      { rpcUrl: 'https://rpc.example/with-batch' },
    ]);
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
    await signX402Payment(v2RequiredTask([V2_BATCH_ACCEPT]), {
      signer: freshSigner(0x12),
      batchSettlement: { storage },
      allowBatchSettlement: true,
    });
    expect(captured.registered).toEqual([
      ['eip155:*', 'upto'],
      ['eip155:*', 'batch-settlement'],
    ]);
    // The scheme receives the signing-read recorder, which must read and
    // write through the caller's records — a detached copy would silently
    // give the payer a second, empty channel record.
    const schemeStorage = captured.batchOptions[0]!
      .storage as X402ClientChannelStorage;
    await storage.set('0xseeded', { balance: '7' });
    expect(await schemeStorage.get('0xseeded')).toEqual({ balance: '7' });
    await schemeStorage.set('0xwritten', { balance: '9' });
    expect(await storage.get('0xwritten')).toEqual({ balance: '9' });
  });

  it.each([
    ['an empty options object', {}],
    ['an explicitly undefined storage', { storage: undefined }],
    ['a storage with a non-callable method', { storage: { get: true } }],
  ])('rejects %s instead of selecting upstream in-memory storage', async (_label, config) => {
    await expect(
      signX402Payment(v2RequiredTask([V2_BATCH_ACCEPT]), {
        signer: freshSigner(0x2f),
        batchSettlement: config as never,
        allowBatchSettlement: true,
      }),
    ).rejects.toThrow(
      'batchSettlement.storage must provide callable get, set, and delete methods',
    );
  });

  it('forwards only the tuning options the caller actually set', async () => {
    captured.batchOptions = [];
    await signX402Payment(v2RequiredTask([V2_BATCH_ACCEPT]), {
      signer: freshSigner(0x13),
      batchSettlement: {
        storage: memoryChannelStorage(),
        depositPolicy: { depositMultiplier: 10 },
        salt: `0x${'ab'.repeat(32)}`,
      },
      allowBatchSettlement: true,
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

  it('reuses the stateless runtime but rebuilds batch options on every signing', async () => {
    const signer = freshSigner(0x14);
    captured.registered = [];
    await signX402Payment(v2RequiredTask(), { signer });
    await signX402Payment(v2RequiredTask(), { signer });
    expect(captured.registered).toHaveLength(1); // upto, registered once

    const firstStorage = memoryChannelStorage();
    const secondStorage = memoryChannelStorage();
    await firstStorage.set('0xmark', { balance: '1' });
    await secondStorage.set('0xmark', { balance: '2' });
    const config = { storage: firstStorage };
    captured.batchOptions = [];
    await signX402Payment(v2RequiredTask([V2_BATCH_ACCEPT]), {
      signer,
      batchSettlement: config,
      allowBatchSettlement: true,
    });
    config.storage = secondStorage;
    await signX402Payment(v2RequiredTask([V2_BATCH_ACCEPT]), {
      signer,
      batchSettlement: config,
      allowBatchSettlement: true,
    });
    // Each signing wraps the storage configured at that moment; the wrapper
    // reads through to the record set on the respective caller storage.
    const [first, second] = captured.batchOptions.map(
      (options) => options.storage as X402ClientChannelStorage,
    );
    expect(await first!.get('0xmark')).toEqual({ balance: '1' });
    expect(await second!.get('0xmark')).toEqual({ balance: '2' });
  });

  it('does not construct an invalid batch scheme when exact was selected', async () => {
    const signed = await signX402Payment(v2RequiredTask([V2_ACCEPT]), {
      signer: freshSigner(0x2e),
      batchSettlement: {
        storage: memoryChannelStorage(),
        depositPolicy: { depositMultiplier: 1 },
      },
      allowBatchSettlement: true,
    });
    expect(signed.requirement).toEqual(V2_ACCEPT);
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
    // Fresh channel: the sentinel is the JSON-safe `null`, never an
    // `undefined` that JSON.stringify would drop from a persisted binding.
    expect(signed.batch?.preAttemptState).toBeNull();
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

  it('captures the pre-attempt snapshot on the signed batch binding', async () => {
    // The snapshot is the trusted base the later reconciliation fold rests
    // on; it is read right after signing, which never writes storage.
    const storage = memoryChannelStorage();
    await storage.set(MOCK_BATCH_CHANNEL.toLowerCase(), {
      balance: '5000',
      chargedCumulativeAmount: '1000',
    });
    const signed = await signX402Payment(v2RequiredTask([V2_BATCH_ACCEPT]), {
      signer: freshSigner(0x1c),
      batchSettlement: { storage },
      allowBatchSettlement: true,
    });
    expect(signed.batch).toEqual({
      channelId: MOCK_BATCH_CHANNEL,
      maxClaimableAmount: '3000',
      attemptId: expect.any(String) as unknown as string,
      preAttemptState: { balance: '5000', chargedCumulativeAmount: '1000' },
    });
  });

  it('leaves batch undefined for a non-batch scheme', async () => {
    const signed = await signX402Payment(v2RequiredTask(), {
      signer: freshSigner(0x1d),
      batchSettlement: { storage: memoryChannelStorage() },
      allowBatchSettlement: true,
    });
    expect(signed.requirement).toEqual(V2_ACCEPT);
    expect(signed.batch).toBeUndefined();
  });

  it('refuses to sign against a quarantined channel', async () => {
    // The marker outlives the process that wrote it; a channel that ended an
    // attempt without a trustworthy reconciliation must not fund or spend
    // again until its record is repaired.
    const storage = memoryChannelStorage();
    await storage.set(MOCK_BATCH_CHANNEL.toLowerCase(), {
      balance: '5000',
      chargedCumulativeAmount: '1000',
      quarantinedAt: '2026-01-01T00:00:00.000Z',
      quarantineReason: 'ambiguous-response',
    });
    await expect(
      signX402Payment(v2RequiredTask([V2_BATCH_ACCEPT]), {
        signer: freshSigner(0x1e),
        batchSettlement: { storage },
        allowBatchSettlement: true,
      }),
    ).rejects.toThrow(X402ChannelQuarantinedError);
  });

  it('fails closed when the snapshot read fails after signing', async () => {
    // Without the snapshot the attempt's reconciliation basis is unknown;
    // the payload must not reach the merchant. Nothing was submitted yet, so
    // refusing here moves no funds.
    const storage: X402ClientChannelStorage = {
      get: async () => {
        throw new Error('storage down');
      },
      set: async () => {},
      delete: async () => {},
    };
    await expect(
      signX402Payment(v2RequiredTask([V2_BATCH_ACCEPT]), {
        signer: freshSigner(0x1f),
        batchSettlement: { storage },
        allowBatchSettlement: true,
      }),
    ).rejects.toThrow(/snapshot the pre-attempt channel state/);
  });
});

describe('reconcileX402BatchSettlement', () => {
  const CHANNEL_A = `0x${'cd'.repeat(32)}`;
  const CHANNEL_B = `0x${'ef'.repeat(32)}`;
  const FOREIGN = `0x${'ab'.repeat(32)}`;
  // Ceilings the payer's vouchers authorized on each channel. Both attempts
  // signed against fresh channels, so the trusted snapshot is undefined.
  const BIND_A = {
    channelId: CHANNEL_A,
    maxClaimableAmount: '3000',
    attemptId: 'attempt-2',
    preAttemptState: undefined,
  };
  const BIND_B = {
    channelId: CHANNEL_B,
    maxClaimableAmount: '6000',
    attemptId: 'attempt-3',
    preAttemptState: undefined,
  };

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
    const storage = memoryChannelStorage();
    const { applied } = await reconcileX402BatchSettlement([channelReceipt], {
      storage,
      bindings: BIND_A,
    });
    expect(applied).toEqual([CHANNEL_A]);
    expect(await storage.get(CHANNEL_A.toLowerCase())).toEqual({
      chargedCumulativeAmount: '3000',
      balance: '15000',
      totalClaimed: '0',
      lastAppliedAttemptId: BIND_A.attemptId,
    });
  });

  it('ignores a receipt naming a channel outside channelIds', async () => {
    // Channel ids are computable from public inputs, so a merchant this payer
    // *did* pay could otherwise name a channel belonging to a different
    // merchant and overwrite its cumulative — bricking it, or forcing an
    // invalid top-up.
    const storage = memoryChannelStorage();
    const { applied } = await reconcileX402BatchSettlement(
      [{ ...channelReceipt, extra: { channelState: { channelId: FOREIGN } } }],
      { storage, bindings: BIND_A },
    );
    expect(applied).toEqual([]);
    expect(await storage.get(FOREIGN.toLowerCase())).toBeUndefined();
  });

  it('matches the allowlist case-insensitively', async () => {
    // Storage is keyed on the lowercased id, so a checksummed id from the
    // merchant must still match a lowercase one the payer signed.
    const storage = memoryChannelStorage();
    const { applied } = await reconcileX402BatchSettlement(
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
      { storage, bindings: BIND_A },
    );
    expect(applied).toHaveLength(1);
    expect(await storage.get(CHANNEL_A.toLowerCase())).toMatchObject({
      chargedCumulativeAmount: '3000',
    });
  });

  it('refuses a receipt that carries no cumulative to advance', async () => {
    // A receipt with just `balance` / `totalClaimed` cannot advance the
    // signing base. Counting that as applied would mask the very desync an
    // empty `applied` exists to report.
    const storage = memoryChannelStorage();
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
      { storage, bindings: BIND_A },
    );
    expect(applied).toEqual([]);
    expect(await storage.get(CHANNEL_A.toLowerCase())).toBeUndefined();
  });

  it('refuses a negative cumulative', async () => {
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

  it('ignores receipts from other schemes', async () => {
    // An `exact` receipt has no channelState, so there is nothing to fold —
    // and nothing may be written for it either.
    const storage = memoryChannelStorage();
    const { applied } = await reconcileX402BatchSettlement(
      [{ success: true, transaction: '0xabc', network: 'eip155:84532' }],
      { storage, bindings: BIND_A },
    );
    expect(applied).toEqual([]);
    expect(await storage.get(CHANNEL_A.toLowerCase())).toBeUndefined();
  });

  it('skips failed receipts', async () => {
    const storage = memoryChannelStorage();
    const { applied } = await reconcileX402BatchSettlement(
      [{ ...channelReceipt, success: false, errorReason: 'CHANNEL_BUSY' }],
      { storage, bindings: BIND_A },
    );
    expect(applied).toEqual([]);
    expect(await storage.get(CHANNEL_A.toLowerCase())).toBeUndefined();
  });

  it('skips malformed entries without dropping a later valid receipt', async () => {
    const storage = memoryChannelStorage();
    const { applied } = await reconcileX402BatchSettlement(
      [null, 'not-a-receipt', 42, [], channelReceipt] as never,
      { storage, bindings: BIND_A },
    );
    expect(applied).toEqual([CHANNEL_A]);
    expect(await storage.get(CHANNEL_A.toLowerCase())).toMatchObject({
      chargedCumulativeAmount: '3000',
    });
  });

  it('screens out a channelState with no canonical channelId', async () => {
    // Storage is keyed on `channelState.channelId.toLowerCase()`, so an
    // unusable id would surface as a bare TypeError. Requiring the canonical
    // bytes32 form also stops a near-miss id becoming a second, orphaned
    // storage key.
    const { applied } = await reconcileX402BatchSettlement(
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
    expect(applied).toEqual([]);
  });

  it('still applies the good receipts when one fails, then reports', async () => {
    // Receipts are remote-controlled. One entry failing its write must not
    // drop a later valid one — a receipt the payer never records leaves it
    // desynced, and `@x402/evm` cannot self-heal that without a
    // chain-reading signer.
    const channels = new Map<string, Record<string, unknown>>();
    const storage = {
      get: async (key: string) => channels.get(key),
      set: async (key: string, state: Record<string, unknown>) => {
        if (key === CHANNEL_B.toLowerCase()) {
          throw new Error('channel storage write failed');
        }
        channels.set(key, state);
      },
      delete: async (key: string) => {
        channels.delete(key);
      },
    };
    const poisoned: X402SettleResponse = {
      ...channelReceipt,
      extra: {
        channelState: {
          channelId: CHANNEL_B,
          chargedCumulativeAmount: '6000',
        },
      },
    };
    await expect(
      reconcileX402BatchSettlement([poisoned, channelReceipt], {
        storage,
        bindings: [BIND_A, BIND_B],
      }),
    ).rejects.toThrow(AggregateError);
    // The valid receipt after the failing one was still recorded.
    expect(channels.get(CHANNEL_A.toLowerCase())).toMatchObject({
      chargedCumulativeAmount: '3000',
    });
  });

  it('processes every allowed channel receipt on a task, in order', async () => {
    const storage = memoryChannelStorage();
    const second: X402SettleResponse = {
      ...channelReceipt,
      extra: {
        channelState: { channelId: CHANNEL_B, chargedCumulativeAmount: '6000' },
      },
    };
    const { applied } = await reconcileX402BatchSettlement(
      [channelReceipt, second],
      { storage, bindings: [BIND_A, BIND_B] },
    );
    expect(applied).toEqual([CHANNEL_A, CHANNEL_B]);
    expect(await storage.get(CHANNEL_A.toLowerCase())).toMatchObject({
      chargedCumulativeAmount: '3000',
    });
    expect(await storage.get(CHANNEL_B.toLowerCase())).toMatchObject({
      chargedCumulativeAmount: '6000',
    });
  });

  it('rejects duplicate bindings for the same channel', async () => {
    await expect(
      reconcileX402BatchSettlement([channelReceipt], {
        storage: memoryChannelStorage(),
        bindings: [
          {
            channelId: CHANNEL_A,
            maxClaimableAmount: '1000',
            depositAmount: '5000',
            attemptId: 'attempt-4',
            preAttemptState: undefined,
          },
          {
            channelId: CHANNEL_A,
            maxClaimableAmount: '3000',
            attemptId: 'attempt-5',
            preAttemptState: undefined,
          },
        ],
      }),
    ).rejects.toThrow(X402PaymentRequiredError);
  });
});

describe('reconcileX402BatchSettlement cumulative binding', () => {
  const CHANNEL = `0x${'cd'.repeat(32)}`;
  const binding = {
    channelId: CHANNEL,
    maxClaimableAmount: '3000',
    attemptId: 'attempt-6',
    preAttemptState: undefined,
  };

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
    const storage = memoryChannelStorage();
    const { applied } = await reconcileX402BatchSettlement(
      [receiptWithCumulative('5000')],
      { storage, bindings: binding },
    );
    expect(applied).toEqual([]);
    expect(await storage.get(CHANNEL.toLowerCase())).toBeUndefined();
  });

  it('accepts a cumulative equal to the signed ceiling', async () => {
    const { applied } = await reconcileX402BatchSettlement(
      [receiptWithCumulative('3000')],
      { storage: memoryChannelStorage(), bindings: binding },
    );
    expect(applied).toEqual([CHANNEL]);
  });

  it('accepts and stores a metered cumulative below the signed ceiling', async () => {
    // The voucher authorizes a ceiling of `base + offered amount`, but a2x's
    // own server can meter the call via `X402Context.settle({ amountAtomic })`
    // — verify runs against the offered amount while settle advances the
    // server cumulative by only the metered charge. A successful receipt
    // therefore legitimately reports `pre-attempt base + chargedAmount`,
    // anywhere up to the ceiling, and the fold must commit that reported
    // figure — writing the ceiling would overstate what the merchant may
    // claim against the next voucher.
    const storage = memoryChannelStorage();
    await storage.set(CHANNEL.toLowerCase(), {
      balance: '10000',
      chargedCumulativeAmount: '5000',
    });
    const metered = receiptWithCumulative('5500');
    metered.extra!.chargedAmount = '500';

    const { applied } = await reconcileX402BatchSettlement([metered], {
      storage,
      bindings: {
        channelId: CHANNEL,
        maxClaimableAmount: '6000',
        attemptId: 'attempt-7',
        preAttemptState: {
          balance: '10000',
          chargedCumulativeAmount: '5000',
        },
      },
    });

    expect(applied).toEqual([CHANNEL]);
    expect(await storage.get(CHANNEL.toLowerCase())).toMatchObject({
      balance: '10000',
      chargedCumulativeAmount: '5500',
    });
  });

  it('refuses a metered cumulative inconsistent with its chargedAmount', async () => {
    // The metered acceptance is an exact cross-field equation, not a range:
    // a reported figure that does not equal `pre-attempt base + chargedAmount`
    // is a fabrication even when it sits below the ceiling.
    const storage = memoryChannelStorage();
    await storage.set(CHANNEL.toLowerCase(), {
      balance: '10000',
      chargedCumulativeAmount: '5000',
    });
    const inconsistent = receiptWithCumulative('5600');
    inconsistent.extra!.chargedAmount = '500';

    const { applied } = await reconcileX402BatchSettlement([inconsistent], {
      storage,
      bindings: {
        channelId: CHANNEL,
        maxClaimableAmount: '6000',
        attemptId: 'attempt-8',
        preAttemptState: {
          balance: '10000',
          chargedCumulativeAmount: '5000',
        },
      },
    });

    expect(applied).toEqual([]);
    expect(await storage.get(CHANNEL.toLowerCase())).toEqual({
      balance: '10000',
      chargedCumulativeAmount: '5000',
    });
  });

  it('records an opening deposit when the metered charge is zero', async () => {
    // Zero usage does not undo the on-chain deposit. The payer must retain
    // the funded balance even though its cumulative remains at zero.
    const storage = memoryChannelStorage();
    const zeroCharge = receiptWithCumulative('0');
    zeroCharge.extra!.chargedAmount = '0';

    const { applied } = await reconcileX402BatchSettlement([zeroCharge], {
      storage,
      bindings: {
        channelId: CHANNEL,
        maxClaimableAmount: '1000',
        depositAmount: '5000',
        attemptId: 'attempt-9',
        preAttemptState: undefined,
      },
    });

    expect(applied).toEqual([CHANNEL]);
    expect(await storage.get(CHANNEL.toLowerCase())).toMatchObject({
      balance: '5000',
      chargedCumulativeAmount: '0',
    });
  });

  it('records an opening deposit when the authorized amount is zero', async () => {
    // The unmetered edge of the same guarantee: a zero-priced call can still
    // open a funded channel (the deposit is sized by policy/strategy, not by
    // one call's price), and the ceiling is `base + amount = 0`.
    const storage = memoryChannelStorage();
    const zeroCharge = receiptWithCumulative('0');

    const { applied } = await reconcileX402BatchSettlement([zeroCharge], {
      storage,
      bindings: {
        channelId: CHANNEL,
        maxClaimableAmount: '0',
        depositAmount: '5000',
        attemptId: 'attempt-10',
        preAttemptState: undefined,
      },
    });

    expect(applied).toEqual([CHANNEL]);
    expect(await storage.get(CHANNEL.toLowerCase())).toMatchObject({
      balance: '5000',
      chargedCumulativeAmount: '0',
    });
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
    const { applied } = await reconcileX402BatchSettlement(
      [receiptWithCumulative('1000')],
      {
        storage,
        bindings: {
          ...binding,
          attemptId: 'attempt-11',
          preAttemptState: { chargedCumulativeAmount: '1000', balance: '5000' },
        },
      },
    );
    expect(applied).toEqual([]);
    expect(await storage.get(CHANNEL.toLowerCase())).toMatchObject({
      chargedCumulativeAmount: '1000',
    });
  });

  it('refuses an unparseable cumulative', async () => {
    const { applied } = await reconcileX402BatchSettlement(
      [receiptWithCumulative('not-a-number'), receiptWithCumulative({})],
      { storage: memoryChannelStorage(), bindings: binding },
    );
    expect(applied).toEqual([]);
  });

  it('drops a binding whose ceiling cannot be parsed rather than unbounding it', async () => {
    const { applied } = await reconcileX402BatchSettlement(
      [receiptWithCumulative('1')],
      {
        storage: memoryChannelStorage(),
        bindings: {
          channelId: CHANNEL,
          maxClaimableAmount: 'oops',
          attemptId: 'attempt-12',
          preAttemptState: undefined,
        },
      },
    );
    expect(applied).toEqual([]);
  });

  it('rejects an unchecked binding that omits the required pre-attempt snapshot key', async () => {
    // JavaScript and deserialized callers can bypass the TypeScript-required
    // property. Treating omission as a fresh channel silently drops the
    // trusted existing balance from the reconciliation floor.
    const storage = memoryChannelStorage();
    await storage.set(CHANNEL.toLowerCase(), {
      balance: '5000',
      chargedCumulativeAmount: '1000',
    });
    const receipt = {
      ...receiptWithCumulative('2000'),
      extra: {
        channelState: {
          channelId: CHANNEL,
          balance: '0',
          chargedCumulativeAmount: '2000',
        },
      },
    } as X402SettleResponse;
    const unchecked = {
      channelId: CHANNEL,
      maxClaimableAmount: '2000',
    } as unknown as X402BatchSettlementBinding;

    await expect(
      reconcileX402BatchSettlement([receipt], {
        storage,
        bindings: unchecked,
      }),
    ).rejects.toThrow(/preAttemptState/);
    expect(await storage.get(CHANNEL.toLowerCase())).toMatchObject({
      balance: '5000',
      chargedCumulativeAmount: '1000',
    });
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

  async function storedBalance(
    storage: X402ClientChannelStorage,
  ): Promise<unknown> {
    return (await storage.get(CHANNEL.toLowerCase()))?.balance;
  }

  it('substitutes the floor for a balance below what this attempt funded', async () => {
    // The aggregate attack: `maxAmount` caps each deposit individually, so a
    // merchant reporting `balance: "0"` every round induces another
    // individually-capped deposit every round, unbounded in total. Within a
    // payment flow the balance only ever goes up, so anything below the floor
    // is a figure the merchant could not have reached honestly.
    const storage = memoryChannelStorage();
    await reconcileX402BatchSettlement([receipt('0')], {
      storage,
      bindings: {
        channelId: CHANNEL,
        maxClaimableAmount: '1000',
        depositAmount: '5000',
        attemptId: 'attempt-13',
        preAttemptState: undefined,
      },
    });
    expect(await storage.get(CHANNEL.toLowerCase())).toMatchObject({
      balance: '5000',
      chargedCumulativeAmount: '1000',
    });
  });

  it('substitutes the floor when the merchant omits balance', async () => {
    const storage = memoryChannelStorage();
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
        storage,
        bindings: {
          channelId: CHANNEL,
          maxClaimableAmount: '1000',
          depositAmount: '5000',
          attemptId: 'attempt-14',
          preAttemptState: undefined,
        },
      },
    );
    expect(await storedBalance(storage)).toBe('5000');
  });

  it('keeps a balance at or above the floor', async () => {
    const storage = memoryChannelStorage();
    await reconcileX402BatchSettlement([receipt('5000')], {
      storage,
      bindings: {
        channelId: CHANNEL,
        maxClaimableAmount: '1000',
        depositAmount: '5000',
        attemptId: 'attempt-15',
        preAttemptState: undefined,
      },
    });
    expect(await storedBalance(storage)).toBe('5000');
  });

  it('adds the snapshot balance to the floor for a top-up', async () => {
    // Snapshot balance 5000 + this deposit 5000 = 10000. Reporting 5000 back
    // would hide the top-up and invite yet another one.
    const storage = memoryChannelStorage();
    await storage.set(CHANNEL.toLowerCase(), { balance: '5000' });
    await reconcileX402BatchSettlement([receipt('5000')], {
      storage,
      bindings: {
        channelId: CHANNEL,
        maxClaimableAmount: '1000',
        depositAmount: '5000',
        attemptId: 'attempt-16',
        preAttemptState: { balance: '5000' },
      },
    });
    expect(await storedBalance(storage)).toBe('10000');
  });

  it('keeps a balance above the floor untouched', async () => {
    // Overstating costs the payer nothing — it can only make the payer
    // under-fund later, and the merchant cannot claim funds never deposited.
    const storage = memoryChannelStorage();
    await reconcileX402BatchSettlement([receipt('999999')], {
      storage,
      bindings: {
        channelId: CHANNEL,
        maxClaimableAmount: '1000',
        attemptId: 'attempt-17',
        preAttemptState: undefined,
      },
    });
    expect(await storedBalance(storage)).toBe('999999');
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
