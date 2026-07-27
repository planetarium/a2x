/**
 * Unit tests for the dual-generation seam: network normalization,
 * generation detection + accessors, and the V1/V2 wire codecs.
 */
import { describe, expect, it } from 'vitest';
import {
  detectGeneration,
  isSupportedVersion,
  payloadMatchesRequirement,
  payloadNetwork,
  requirementAmount,
  X402_DEFAULT_GENERATION,
} from '../x402/generations.js';
import { isCaip2, sameNetwork, toBareName, toCaip2 } from '../x402/networks.js';
import { encodePaymentRequiredV1, encodeRequirementV1 } from '../x402/wire-v1.js';
import { encodePaymentRequiredV2, encodeRequirementV2 } from '../x402/wire-v2.js';
import { normalizeX402Accept } from '../x402/payment.js';
import type {
  X402Accept,
  X402PaymentPayloadV1,
  X402PaymentPayloadV2,
} from '../x402/types.js';

const ACCEPT: X402Accept = {
  network: 'base-sepolia',
  amount: '10000',
  asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  payTo: '0x2222222222222222222222222222222222222222',
  resource: 'https://api.example.com/premium',
  description: 'Premium agent access',
};

describe('networks', () => {
  it('detects CAIP-2 ids', () => {
    expect(isCaip2('eip155:84532')).toBe(true);
    expect(isCaip2('base-sepolia')).toBe(false);
  });

  it('normalizes bare names to CAIP-2 and back', () => {
    expect(toCaip2('base-sepolia')).toBe('eip155:84532');
    expect(toCaip2('base')).toBe('eip155:8453');
    expect(toBareName('eip155:84532')).toBe('base-sepolia');
    expect(toBareName('base-sepolia')).toBe('base-sepolia');
  });

  it('passes through already-CAIP-2 on toCaip2 and unknown bare names', () => {
    expect(toCaip2('eip155:8453')).toBe('eip155:8453');
    expect(toCaip2('solana-mainnet')).toBe('solana-mainnet');
  });

  it('throws when a CAIP-2 id has no bare-name equivalent', () => {
    expect(() => toBareName('eip155:999999')).toThrow(/no known bare-name/);
  });

  it('treats bare and CAIP-2 forms of the same chain as equal', () => {
    expect(sameNetwork('base-sepolia', 'eip155:84532')).toBe(true);
    expect(sameNetwork('base', 'eip155:8453')).toBe(true);
    expect(sameNetwork('base', 'eip155:84532')).toBe(false);
  });
});

describe('generation detection + accessors', () => {
  it('supported versions', () => {
    expect(isSupportedVersion(1)).toBe(true);
    expect(isSupportedVersion(2)).toBe(true);
    expect(isSupportedVersion(3)).toBe(false);
    expect(X402_DEFAULT_GENERATION).toBe(2);
  });

  it('detects generation from an envelope or bare version', () => {
    expect(detectGeneration({ x402Version: 1 })).toBe(1);
    expect(detectGeneration({ x402Version: 2 })).toBe(2);
    expect(detectGeneration(2)).toBe(2);
    expect(detectGeneration({ x402Version: 3 })).toBeUndefined();
    expect(detectGeneration(undefined)).toBeUndefined();
  });

  it('reads amount across generations', () => {
    expect(requirementAmount(encodeRequirementV1(ACCEPT))).toBe('10000');
    expect(requirementAmount(encodeRequirementV2(ACCEPT))).toBe('10000');
  });

  it('reads network + matches requirement across generations', () => {
    const v1Payload: X402PaymentPayloadV1 = {
      x402Version: 1,
      scheme: 'exact',
      network: 'base-sepolia',
      payload: {},
    };
    const v2Payload: X402PaymentPayloadV2 = {
      x402Version: 2,
      accepted: encodeRequirementV2(ACCEPT),
      payload: {},
    };
    expect(payloadNetwork(v1Payload)).toBe('base-sepolia');
    expect(payloadNetwork(v2Payload)).toBe('eip155:84532');
    // Cross-generation network equivalence: a V1 payload matches a V2
    // requirement for the same chain and vice versa.
    expect(payloadMatchesRequirement(v1Payload, encodeRequirementV2(ACCEPT))).toBe(
      true,
    );
    expect(payloadMatchesRequirement(v2Payload, encodeRequirementV1(ACCEPT))).toBe(
      true,
    );
  });
});

describe('wire codecs', () => {
  it('V1 codec matches the legacy normalizeX402Accept shape', () => {
    expect(encodeRequirementV1(ACCEPT)).toEqual(normalizeX402Accept(ACCEPT));
  });

  it('V1 payment-required has x402Version 1, bare network, maxAmountRequired', () => {
    const req = encodePaymentRequiredV1([ACCEPT]);
    expect(req.x402Version).toBe(1);
    expect(req.accepts[0]!.network).toBe('base-sepolia');
    expect(req.accepts[0]!.maxAmountRequired).toBe('10000');
    expect(req.accepts[0]!.resource).toBe('https://api.example.com/premium');
  });

  it('V2 payment-required has x402Version 2, CAIP-2, amount, hoisted resource', () => {
    const req = encodePaymentRequiredV2([ACCEPT]);
    expect(req.x402Version).toBe(2);
    expect(req.resource).toEqual({
      url: 'https://api.example.com/premium',
      description: 'Premium agent access',
      mimeType: 'application/json',
    });
    expect(req.accepts[0]!.network).toBe('eip155:84532');
    expect(req.accepts[0]!.amount).toBe('10000');
    // V2 requirements do not carry resource/description/mimeType inline.
    expect('resource' in req.accepts[0]!).toBe(false);
    expect('maxAmountRequired' in req.accepts[0]!).toBe(false);
  });

  it('V2 accepts a CAIP-2 network on the input unchanged', () => {
    const req = encodePaymentRequiredV2([{ ...ACCEPT, network: 'eip155:8453' }]);
    expect(req.accepts[0]!.network).toBe('eip155:8453');
  });

  it('carries an error string through both codecs', () => {
    expect(encodePaymentRequiredV1([ACCEPT], { error: 'boom' }).error).toBe('boom');
    expect(encodePaymentRequiredV2([ACCEPT], { error: 'boom' }).error).toBe('boom');
  });

  it('defaults `extra` to the asset-correct EIP-712 domain', () => {
    // Base Sepolia USDC → name "USDC"; Base mainnet USDC → name "USD Coin".
    const sepolia = encodeRequirementV1({ ...ACCEPT });
    expect(sepolia.extra).toEqual({ name: 'USDC', version: '2' });

    const mainnet = encodeRequirementV2({
      ...ACCEPT,
      network: 'base',
      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913',
    });
    expect(mainnet.extra).toEqual({ name: 'USD Coin', version: '2' });
  });

  it('honors a caller-supplied `extra` over the default', () => {
    const req = encodeRequirementV2({
      ...ACCEPT,
      extra: { name: 'DAI', version: '1' },
    });
    expect(req.extra).toEqual({ name: 'DAI', version: '1' });
  });
});
