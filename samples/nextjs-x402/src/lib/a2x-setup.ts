import {
  AgentExecutor,
  A2XAgent,
  BaseAgent,
  DefaultRequestHandler,
  InMemoryPushNotificationConfigStore,
  InMemoryRunner,
  InMemoryTaskStore,
  StreamingMode,
  X402PaymentExecutor,
  X402_EXTENSION_URI,
  paymentRequiredEvent,
  type AgentEvent,
} from '@a2x/sdk';
import type { InvocationContext } from '@a2x/sdk';

/**
 * A toy storefront agent to showcase both x402 flows:
 *
 *  - **Standalone gate**: the executor charges a tiny "browsing fee" up
 *    front before the agent runs.
 *  - **Embedded flow**: once the user is past the gate, the agent hands
 *    back a cart artifact with an x402 challenge sized to the chosen
 *    SKU — a per-purchase charge that settles before shoes ship.
 *
 * The SKUs are hardcoded in a fake inventory. Real integrations would
 * swap this for a price lookup, stripping out the trailing "ship"
 * message into whatever post-purchase work your agent actually does.
 */
const INVENTORY: Record<string, { name: string; priceUsdc: string }> = {
  'sku-air-max': { name: 'Nike Air Max', priceUsdc: '120000' },   // 0.12 USDC
  'sku-react-tee': { name: 'React Tee', priceUsdc: '50000' },     // 0.05 USDC
};

class StorefrontAgent extends BaseAgent {
  constructor() {
    super({
      name: 'storefront_agent',
      description:
        'Sells a tiny in-memory inventory via an x402 embedded-flow checkout.',
    });
  }

  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    const last = [...context.session.events]
      .reverse()
      .find((e) => e.type === 'text' && e.role === 'user');
    const text = last && last.type === 'text' ? last.text : '';

    // Pick a SKU out of the user text; default to the first.
    const skuId =
      Object.keys(INVENTORY).find((id) => text.includes(id)) ??
      'sku-air-max';
    const sku = INVENTORY[skuId]!;

    yield {
      type: 'text',
      role: 'agent',
      text: `Adding ${sku.name} to cart (${formatUsdc(sku.priceUsdc)} USDC)… `,
    };

    // Suspend until the client pays for the item.
    yield paymentRequiredEvent({
      accepts: [
        {
          network: 'base-sepolia',
          amount: sku.priceUsdc,
          asset: USDC_BASE_SEPOLIA,
          payTo: resolveMerchantAddress(),
          description: `Checkout: ${sku.name}`,
        },
      ],
      embeddedObject: {
        cartId: `cart-${skuId}`,
        items: [{ id: skuId, name: sku.name }],
        total: {
          currency: 'USD',
          // Friendly decimal value for UIs; ignore for payment math.
          value: Number(sku.priceUsdc) / 1_000_000,
        },
      },
      artifactName: 'demo-cart',
    });

    yield {
      type: 'text',
      role: 'agent',
      text: `Shipped ${sku.name}! Thanks for the purchase.`,
    };
    yield { type: 'done' };
  }
}

function formatUsdc(amount: string): string {
  return (Number(amount) / 1_000_000).toFixed(6).replace(/0+$/, '').replace(/\.$/, '');
}

const MISSING_ADDRESS_PLACEHOLDER = '0x0000000000000000000000000000000000000000';

const resolveMerchantAddress = (): string => {
  const value = process.env.X402_MERCHANT_ADDRESS;
  if (!value || value.length === 0) {
    if (process.env.NEXT_PHASE !== 'phase-production-build') {
      console.warn(
        '[a2x-x402 sample] X402_MERCHANT_ADDRESS is not set. Falling back to the zero address — payments will never succeed until you configure a real one (.env).',
      );
    }
    return MISSING_ADDRESS_PLACEHOLDER;
  }
  return value;
};

// USDC contract address on Base Sepolia (official Circle deployment).
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const agent = new StorefrontAgent();
const runner = new InMemoryRunner({ agent, appName: 'nextjs-x402' });

const innerExecutor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
});

// Development escape hatch: when X402_MOCK_FACILITATOR=1 the sample skips
// verify/settle entirely and returns a fake receipt. Useful for running
// the sample without an actual funded Base Sepolia wallet.
const mockFacilitator = process.env.X402_MOCK_FACILITATOR === '1'
  ? {
      async verify() {
        return { isValid: true, invalidReason: undefined, payer: '0xmock' as `0x${string}` };
      },
      async settle() {
        return {
          success: true,
          transaction: '0xmocktx',
          network: 'base-sepolia' as const,
          payer: '0xmock' as `0x${string}`,
        };
      },
    }
  : undefined;

const paymentExecutor = new X402PaymentExecutor(innerExecutor, {
  // Standalone "browsing fee" gate — 0.001 USDC. Set `requiresPayment: () =>
  // false` or remove `accepts` entirely for a pure embedded-only flow.
  accepts: [
    {
      network: 'base-sepolia',
      amount: '1000',
      asset: USDC_BASE_SEPOLIA,
      payTo: resolveMerchantAddress(),
      description: 'Storefront browsing fee',
    },
  ],
  ...(mockFacilitator
    ? { facilitator: mockFacilitator }
    : process.env.X402_FACILITATOR_URL
      ? { facilitator: { url: process.env.X402_FACILITATOR_URL } }
      : {}),
});

export const a2xAgent = new A2XAgent({
  taskStore: new InMemoryTaskStore(),
  executor: paymentExecutor,
  protocolVersion: '1.0',
  pushNotificationConfigStore: new InMemoryPushNotificationConfigStore(),
})
  .setDefaultUrl(
    `${process.env.BASE_URL ?? 'http://localhost:3000'}/api/a2a`,
  )
  .addSkill({
    id: 'shop',
    name: 'x402 Storefront',
    description:
      'Browse and buy a tiny demo inventory. Gate fee + per-item checkout via x402 embedded flow.',
    tags: ['shop', 'x402', 'embedded', 'demo'],
  })
  .addExtension({ uri: X402_EXTENSION_URI, required: true });

export const handler = new DefaultRequestHandler(a2xAgent);
