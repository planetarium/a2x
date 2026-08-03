import { describe, expect, it, vi } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { TaskState, type Task } from '../types/task.js';
import {
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
} from '../x402/constants.js';
import { signX402Payment } from '../x402/client.js';

// The docs promise that `signX402Payment` hands the received envelope —
// including V2 `extensions`, which gate gas sponsoring in `@x402/evm` — to
// the signing runtime. That forwarding rests on an object spread that a
// field-by-field refactor could silently drop, so pin it here. The peer
// loader is mocked because the assertion is about what reaches
// `createPaymentPayload`, not about real signing (x402-client.test.ts covers
// that with the real peers, and `vi.mock` is file-scoped).
const captured: { envelope?: unknown } = {};

vi.mock('../x402/peer.js', () => ({
  importX402Peer: vi.fn(async (specifier: string) => {
    if (specifier === '@x402/core/client') {
      return {
        x402Client: class {
          async createPaymentPayload(envelope: unknown) {
            captured.envelope = envelope;
            return {
              x402Version: 2,
              scheme: 'exact',
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
    throw new Error(`unexpected peer import: ${specifier}`);
  }),
}));

const SIGNER = privateKeyToAccount(
  '0x3333333333333333333333333333333333333333333333333333333333333333',
);

const V2_ACCEPT = {
  scheme: 'exact',
  network: 'eip155:84532',
  amount: '1000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x2222222222222222222222222222222222222222',
  maxTimeoutSeconds: 300,
  extra: { name: 'USDC', version: '2' },
};

const EXTENSIONS = { eip2612GasSponsoring: {}, erc20ApprovalGasSponsoring: {} };

function v2RequiredTask(): Task {
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
            accepts: [V2_ACCEPT],
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
});
