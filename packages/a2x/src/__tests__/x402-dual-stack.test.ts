/**
 * Dual-stack (V1/V2) negotiation and signing.
 *
 * Covers: server emission generation driven by the client's activated
 * extension, the full V2 Standalone round-trip with real @x402/evm signing,
 * the generation-mismatch guard, and EIP-3009 signature recovery for both
 * generations (the acceptance gate for migrating the signing path).
 */
import { describe, expect, it } from 'vitest';
import { privateKeyToAccount } from 'viem/accounts';
import { recoverTypedDataAddress } from 'viem';
import type { AgentEvent } from '../agent/base-agent.js';
import {
  X402Context,
  X402_EXTENSION_URI,
  X402_METADATA_KEYS,
  X402_V2_EXTENSION_URI,
  requirementAmount,
  signX402Payment,
  type X402Accept,
  type X402Facilitator,
  type X402PaymentPayload,
  type X402PaymentRequiredResponse,
  type X402EvmAuthorization,
} from '../x402/index.js';
import type { Task } from '../types/task.js';

const ACCOUNT = privateKeyToAccount(
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
);

const ACCEPT: X402Accept = {
  network: 'base-sepolia',
  amount: '10000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x2222222222222222222222222222222222222222',
  resource: 'https://api.example.com/premium',
  description: 'Premium agent access',
};

function mockFacilitator(): X402Facilitator {
  return {
    verify: async () => ({ isValid: true, payer: ACCOUNT.address }),
    settle: async () => ({
      success: true,
      transaction: '0xdeadbeef',
      network: 'eip155:84532',
      payer: ACCOUNT.address,
    }),
  };
}

async function drainMetadata(
  gen: AsyncGenerator<AgentEvent>,
): Promise<Record<string, unknown>> {
  for await (const ev of gen) {
    if (ev.type === 'request-input') return ev.metadata;
  }
  throw new Error('no request-input event');
}

function requiredTask(required: X402PaymentRequiredResponse): Task {
  return {
    id: 't1',
    contextId: 'c1',
    status: {
      state: 'input-required',
      message: {
        messageId: 'm1',
        role: 'agent',
        parts: [{ text: 'pay' }],
        metadata: {
          [X402_METADATA_KEYS.STATUS]: 'payment-required',
          [X402_METADATA_KEYS.REQUIRED]: required,
        },
      },
    },
  } as unknown as Task;
}

describe('server emission generation from activation', () => {
  it('emits V2 when the client activated the V2 URI', async () => {
    const ctx = new X402Context({ facilitator: mockFacilitator() });
    const meta = await drainMetadata(
      ctx.requestPayment(
        { taskId: 't1', activatedExtensions: [X402_V2_EXTENSION_URI] },
        { accepts: [ACCEPT] },
      ),
    );
    const required = meta[X402_METADATA_KEYS.REQUIRED] as X402PaymentRequiredResponse;
    expect(required.x402Version).toBe(2);
    expect(required.accepts[0]!.network).toBe('eip155:84532');
  });

  it('emits V1 when the client activated only the legacy URI', async () => {
    const ctx = new X402Context({ facilitator: mockFacilitator() });
    const meta = await drainMetadata(
      ctx.requestPayment(
        { taskId: 't1', activatedExtensions: [X402_EXTENSION_URI] },
        { accepts: [ACCEPT] },
      ),
    );
    const required = meta[X402_METADATA_KEYS.REQUIRED] as X402PaymentRequiredResponse;
    expect(required.x402Version).toBe(1);
    expect(required.accepts[0]!.network).toBe('base-sepolia');
  });

  it('falls back to V2 when no x402 URI pins a generation (profile is V2-first)', async () => {
    const ctx = new X402Context({ facilitator: mockFacilitator() });
    const meta = await drainMetadata(
      ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT] }),
    );
    const required = meta[X402_METADATA_KEYS.REQUIRED] as X402PaymentRequiredResponse;
    expect(required.x402Version).toBe(2);
  });

  it('honors a V1 default override for legacy fleets', async () => {
    const ctx = new X402Context({
      facilitator: mockFacilitator(),
      defaultGeneration: 1,
    });
    const meta = await drainMetadata(
      ctx.requestPayment({ taskId: 't1' }, { accepts: [ACCEPT] }),
    );
    const required = meta[X402_METADATA_KEYS.REQUIRED] as X402PaymentRequiredResponse;
    expect(required.x402Version).toBe(1);
  });
});

describe('full V2 round-trip', () => {
  it('offers V2, signs V2, classifies valid, settles with CAIP-2 receipt', async () => {
    const ctx = new X402Context({ facilitator: mockFacilitator() });
    // Offer under V2.
    await drainMetadata(
      ctx.requestPayment(
        { taskId: 't1', activatedExtensions: [X402_V2_EXTENSION_URI] },
        { accepts: [ACCEPT] },
      ),
    );
    const stored = await ctx.store.get('t1');
    expect(stored?.offeredGeneration).toBe(2);

    // Client signs the V2 requirement.
    const required = encodeRequiredFromStore(stored!.accepts, 2);
    const signed = await signX402Payment(requiredTask(required), {
      signer: ACCOUNT,
    });
    expect(signed.payload.x402Version).toBe(2);

    // Server classifies the V2 submission and settles.
    const classified = await ctx.classify({
      taskId: 't1',
      message: {
        messageId: 'm2',
        role: 'user',
        parts: [{ text: '' }],
        metadata: {
          [X402_METADATA_KEYS.STATUS]: 'payment-submitted',
          [X402_METADATA_KEYS.PAYLOAD]: signed.payload,
        },
      } as never,
    });
    expect(classified.kind).toBe('valid');
    if (classified.kind !== 'valid') return;
    const receipt = await ctx.settle({ taskId: 't1' }, classified);
    expect(receipt.success).toBe(true);
    expect(receipt.network).toBe('eip155:84532');
  });

  it('rejects a V1 submission against a V2 offering (generation mismatch)', async () => {
    const ctx = new X402Context({ facilitator: mockFacilitator() });
    await drainMetadata(
      ctx.requestPayment(
        { taskId: 't1', activatedExtensions: [X402_V2_EXTENSION_URI] },
        { accepts: [ACCEPT] },
      ),
    );
    // A V1-shaped submission.
    const classified = await ctx.classify({
      taskId: 't1',
      message: {
        messageId: 'm2',
        role: 'user',
        parts: [{ text: '' }],
        metadata: {
          [X402_METADATA_KEYS.STATUS]: 'payment-submitted',
          [X402_METADATA_KEYS.PAYLOAD]: {
            x402Version: 1,
            scheme: 'exact',
            network: 'base-sepolia',
            payload: {},
          },
        },
      } as never,
    });
    expect(classified.kind).toBe('unmatched');
  });
});

describe('EIP-3009 signature recovery (both generations)', () => {
  for (const [label, uri, expectedVersion] of [
    ['V1', X402_EXTENSION_URI, 1],
    ['V2', X402_V2_EXTENSION_URI, 2],
  ] as const) {
    it(`${label} payload signature recovers to the signer`, async () => {
      const ctx = new X402Context({ facilitator: mockFacilitator() });
      await drainMetadata(
        ctx.requestPayment(
          { taskId: 't1', activatedExtensions: [uri] },
          { accepts: [ACCEPT] },
        ),
      );
      const stored = await ctx.store.get('t1');
      const required = encodeRequiredFromStore(stored!.accepts, expectedVersion);
      const signed = await signX402Payment(requiredTask(required), {
        signer: ACCOUNT,
      });
      expect(signed.payload.x402Version).toBe(expectedVersion);

      const inner = (signed.payload as X402PaymentPayload).payload as {
        signature: `0x${string}`;
        authorization: X402EvmAuthorization;
      };
      const recovered = await recoverTypedDataAddress({
        domain: {
          name: 'USDC',
          version: '2',
          chainId: 84532,
          verifyingContract: ACCEPT.asset as `0x${string}`,
        },
        types: {
          TransferWithAuthorization: [
            { name: 'from', type: 'address' },
            { name: 'to', type: 'address' },
            { name: 'value', type: 'uint256' },
            { name: 'validAfter', type: 'uint256' },
            { name: 'validBefore', type: 'uint256' },
            { name: 'nonce', type: 'bytes32' },
          ],
        },
        primaryType: 'TransferWithAuthorization',
        message: {
          from: inner.authorization.from as `0x${string}`,
          to: inner.authorization.to as `0x${string}`,
          value: BigInt(inner.authorization.value),
          validAfter: BigInt(inner.authorization.validAfter),
          validBefore: BigInt(inner.authorization.validBefore),
          nonce: inner.authorization.nonce as `0x${string}`,
        },
        signature: inner.signature,
      });
      expect(recovered.toLowerCase()).toBe(ACCOUNT.address.toLowerCase());
    });
  }
});

function submitMessage(payload: unknown) {
  return {
    messageId: 'm2',
    role: 'user',
    parts: [{ text: '' }],
    metadata: {
      [X402_METADATA_KEYS.STATUS]: 'payment-submitted',
      [X402_METADATA_KEYS.PAYLOAD]: payload,
    },
  } as never;
}

describe('adversarial code-review regressions', () => {
  it('binds a multi-tier V2 submission to the tier the client actually signed', async () => {
    const ctx = new X402Context({ facilitator: mockFacilitator() });
    const accepts: X402Accept[] = [ACCEPT, { ...ACCEPT, amount: '50000' }];
    await drainMetadata(
      ctx.requestPayment(
        { taskId: 't1', activatedExtensions: [X402_V2_EXTENSION_URI] },
        { accepts },
      ),
    );
    const stored = await ctx.store.get('t1');
    const required = encodeRequiredFromStore(stored!.accepts, 2);
    // Client signs the *higher* tier — matching on network+scheme alone would
    // bind it to the first (10000) tier and reject it as INVALID_AMOUNT.
    const signed = await signX402Payment(requiredTask(required), {
      signer: ACCOUNT,
      selectRequirement: (reqs) =>
        reqs.find((r) => requirementAmount(r) === '50000'),
    });
    const classified = await ctx.classify({
      taskId: 't1',
      message: submitMessage(signed.payload),
    });
    expect(classified.kind).toBe('valid');
  });

  it('rejects an unsupported x402Version with invalid_x402_version', async () => {
    const ctx = new X402Context({ facilitator: mockFacilitator() });
    await drainMetadata(
      ctx.requestPayment(
        { taskId: 't1', activatedExtensions: [X402_V2_EXTENSION_URI] },
        { accepts: [ACCEPT] },
      ),
    );
    const classified = await ctx.classify({
      taskId: 't1',
      message: submitMessage({
        x402Version: 3,
        accepted: { scheme: 'exact', network: 'eip155:84532' },
        payload: {},
      }),
    });
    expect(classified.kind).toBe('unmatched');
    if (classified.kind === 'unmatched') {
      expect(classified.code).toBe('invalid_x402_version');
    }
  });

  it('verify returns isValid:false and records failure when the facilitator throws', async () => {
    const throwing: X402Facilitator = {
      verify: async () => {
        throw new Error('facilitator 500');
      },
      settle: async () => {
        throw new Error('facilitator 500');
      },
    };
    const ctx = new X402Context({ facilitator: throwing });
    await drainMetadata(
      ctx.requestPayment(
        { taskId: 't1', activatedExtensions: [X402_V2_EXTENSION_URI] },
        { accepts: [ACCEPT] },
      ),
    );
    const required = encodeRequiredFromStore((await ctx.store.get('t1'))!.accepts, 2);
    const signed = await signX402Payment(requiredTask(required), { signer: ACCOUNT });
    const classified = await ctx.classify({
      taskId: 't1',
      message: submitMessage(signed.payload),
    });
    if (classified.kind !== 'valid') throw new Error('expected valid');
    const v = await ctx.verify({ taskId: 't1' }, classified);
    expect(v.isValid).toBe(false);
    expect((await ctx.store.get('t1'))?.status).toBe('failed');
  });

  it('default selection skips a non-EVM rail and picks the EVM option', async () => {
    const required = {
      x402Version: 2 as const,
      resource: { url: 'https://x', description: 'd', mimeType: 'application/json' },
      accepts: [
        {
          scheme: 'exact',
          network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
          asset: 'So11111111111111111111111111111111111111112',
          amount: '10000',
          payTo: ACCEPT.payTo,
          maxTimeoutSeconds: 300,
          extra: {},
        },
        {
          scheme: 'exact',
          network: 'eip155:84532',
          asset: ACCEPT.asset,
          amount: '10000',
          payTo: ACCEPT.payTo,
          maxTimeoutSeconds: 300,
          extra: { name: 'USDC', version: '2' },
        },
      ],
    };
    const signed = await signX402Payment(
      requiredTask(required as never),
      { signer: ACCOUNT },
    );
    expect(signed.requirement.network).toBe('eip155:84532');
  });
});

// Re-encode an offering the way X402Context would, for the given generation,
// to build the client-facing `payment-required` object in tests.
function encodeRequiredFromStore(
  accepts: X402Accept[],
  generation: 1 | 2,
): X402PaymentRequiredResponse {
  if (generation === 2) {
    return {
      x402Version: 2,
      resource: {
        url: accepts[0]!.resource,
        description: accepts[0]!.description,
        mimeType: accepts[0]!.mimeType ?? 'application/json',
      },
      accepts: accepts.map((a) => ({
        scheme: 'exact',
        network: 'eip155:84532',
        asset: a.asset,
        amount: a.amount,
        payTo: a.payTo,
        maxTimeoutSeconds: a.maxTimeoutSeconds ?? 300,
        extra: a.extra ?? { name: 'USDC', version: '2' },
      })),
    };
  }
  return {
    x402Version: 1,
    accepts: accepts.map((a) => ({
      scheme: 'exact',
      network: 'base-sepolia',
      maxAmountRequired: a.amount,
      resource: a.resource,
      description: a.description,
      mimeType: a.mimeType ?? 'application/json',
      payTo: a.payTo,
      maxTimeoutSeconds: a.maxTimeoutSeconds ?? 300,
      asset: a.asset,
      extra: a.extra ?? { name: 'USDC', version: '2' },
    })),
  };
}
