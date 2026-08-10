import { describe, expect, it } from 'vitest';
import {
  InMemoryMerchantOfferingSidecar,
  type MerchantOffer,
} from '../x402-merchant/index.js';

function offer(amount: string): MerchantOffer {
  return {
    accepts: [
      {
        scheme: 'exact',
        network: 'eip155:84532',
        amount,
        asset: '0xasset',
        payTo: '0xmerchant',
        description: 'Work',
        resource: 'https://example.com/work',
      },
    ],
  };
}

describe('InMemoryMerchantOfferingSidecar', () => {
  it('freezes the first live offer and returns defensive copies', async () => {
    const sidecar = new InMemoryMerchantOfferingSidecar();
    const seen: string[] = [];
    await sidecar.publishing('task-1', offer('10'), async (frozen) => {
      seen.push(frozen.accepts[0].amount);
    });
    await sidecar.publishing('task-1', offer('20'), async (frozen) => {
      seen.push(frozen.accepts[0].amount);
      (frozen.accepts[0] as { amount: string }).amount = '999';
    });

    expect(seen).toEqual(['10', '10']);
    expect((await sidecar.getOffer('task-1'))?.accepts[0].amount).toBe('10');
  });

  it('grants exactly one execution claim', async () => {
    const sidecar = new InMemoryMerchantOfferingSidecar();
    await sidecar.publishing('task-1', offer('10'), async () => undefined);

    expect(await Promise.all([sidecar.claim('task-1'), sidecar.claim('task-1')])).toEqual([
      true,
      false,
    ]);
  });

  it('rolls back a newly frozen offer when publishing fails', async () => {
    const sidecar = new InMemoryMerchantOfferingSidecar();
    await expect(
      sidecar.publishing('task-1', offer('10'), async () => {
        throw new Error('store failed');
      }),
    ).rejects.toThrow('store failed');
    expect(await sidecar.getOffer('task-1')).toBeUndefined();
  });
});
