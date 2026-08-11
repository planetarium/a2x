import { describe, expect, it, vi } from 'vitest';
import {
  InMemoryMerchantOfferStore,
  type MerchantOffer,
} from '../x402/index.js';

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

describe('InMemoryMerchantOfferStore', () => {
  it('freezes the first live offer and returns defensive copies', async () => {
    const store = new InMemoryMerchantOfferStore();
    const seen: string[] = [];
    await store.publishing('task-1', offer('10'), async (frozen) => {
      seen.push(frozen.accepts[0].amount);
    });
    await store.publishing('task-1', offer('20'), async (frozen) => {
      seen.push(frozen.accepts[0].amount);
      (frozen.accepts[0] as { amount: string }).amount = '999';
    });

    expect(seen).toEqual(['10', '10']);
    expect((await store.getOffer('task-1'))?.accepts[0].amount).toBe('10');
  });

  it('grants exactly one execution claim', async () => {
    const store = new InMemoryMerchantOfferStore();
    await store.publishing('task-1', offer('10'), async () => undefined);

    expect(await Promise.all([store.claim('task-1'), store.claim('task-1')])).toEqual([
      true,
      false,
    ]);
  });

  it('rolls back a newly frozen offer when publishing fails', async () => {
    const store = new InMemoryMerchantOfferStore();
    await expect(
      store.publishing('task-1', offer('10'), async () => {
        throw new Error('store failed');
      }),
    ).rejects.toThrow('store failed');
    expect(await store.getOffer('task-1')).toBeUndefined();
  });

  it('expires offers after the default 10-minute TTL', async () => {
    vi.useFakeTimers();
    try {
      const store = new InMemoryMerchantOfferStore();
      await store.publishing('task-1', offer('10'), async () => undefined);

      vi.advanceTimersByTime(600_000);
      await expect(store.getOffer('task-1')).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('caps the default in-memory store at 10,000 live entries', async () => {
    const store = new InMemoryMerchantOfferStore();
    for (let index = 0; index <= 10_000; index += 1) {
      await store.publishing(`task-${index}`, offer('10'), async () => undefined);
    }

    expect(store.size()).toBe(10_000);
    await expect(store.getOffer('task-0')).resolves.toBeUndefined();
    await expect(store.getOffer('task-10000')).resolves.toBeDefined();
  });
});
