import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { TaskState, type Task } from '../types/task.js';
import {
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
} from '../x402/constants.js';
import { signX402Payment } from '../x402/client.js';
import { X402NoSupportedRequirementError } from '../x402/errors.js';

// The docs promise that `signX402Payment` hands the received envelope —
// including V2 `extensions`, which gate gas sponsoring in `@x402/evm` — to
// the signing runtime. That forwarding rests on an object spread that a
// field-by-field refactor could silently drop, so pin it here. The peer
// loader is mocked because the assertion is about what reaches
// `createPaymentPayload`, not about real signing (x402-client.test.ts covers
// that with the real peers, and `vi.mock` is file-scoped).
const captured: { envelope?: unknown; registered: [string, string][] } = {
  registered: [],
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
    throw new Error(`unexpected peer import: ${specifier}`);
  }),
}));

// `_loadRuntime` memoizes one runtime per signer identity, so every test that
// inspects scheme registration or a fresh envelope uses its own signer.
function freshSigner(seed: string) {
  return privateKeyToAccount(`0x${seed.repeat(64).slice(0, 64)}` as `0x${string}`);
}

const SIGNER = freshSigner('3');

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

const EXTENSIONS = { eip2612GasSponsoring: {}, erc20ApprovalGasSponsoring: {} };

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
    await signX402Payment(v2RequiredTask(), { signer: freshSigner('a') });
    expect(captured.registered).toEqual([['eip155:*', 'upto']]);
  });
});

describe('signX402Payment upto selection policy', () => {
  it('refuses to auto-pick an upto offer without allowUpto', async () => {
    await expect(
      signX402Payment(v2RequiredTask([V2_UPTO_ACCEPT]), {
        signer: freshSigner('b'),
      }),
    ).rejects.toThrow(X402NoSupportedRequirementError);
  });

  it('falls back to upto under allowUpto when no exact offer exists', async () => {
    const signed = await signX402Payment(v2RequiredTask([V2_UPTO_ACCEPT]), {
      signer: freshSigner('c'),
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
      { signer: freshSigner('d'), allowUpto: true },
    );
    expect(signed.requirement).toEqual(V2_ACCEPT);
  });

  it('signs an upto offer chosen by an explicit selectRequirement', async () => {
    const signed = await signX402Payment(
      v2RequiredTask([V2_ACCEPT, V2_UPTO_ACCEPT]),
      {
        signer: freshSigner('e'),
        // No allowUpto — an explicit selector is the caller's own decision.
        selectRequirement: (reqs) => reqs.find((r) => r.scheme === 'upto'),
      },
    );
    expect(signed.requirement).toEqual(V2_UPTO_ACCEPT);
    expect(signed.payload.scheme).toBe('upto');
  });
});
