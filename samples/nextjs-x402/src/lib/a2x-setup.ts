import {
  AgentExecutor,
  A2XAgent,
  BaseAgent,
  DefaultRequestHandler,
  InMemoryPushNotificationConfigStore,
  InMemoryRunner,
  InMemoryTaskStore,
  StreamingMode,
  type AgentEvent,
  type InvocationContext,
} from '@a2x/sdk';

import {
  X402Context,
  InMemoryX402Store,
  X402_EXTENSION_URI,
  type X402Accept,
  type X402Facilitator
} from '@a2x/sdk/x402';

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

const ACCEPTS: X402Accept[] = [
  {
    network: 'base-sepolia',
    // 0.001 USDC — tiny enough to be a believable per-call price on testnet.
    amount: '1000',
    asset: USDC_BASE_SEPOLIA,
    payTo: resolveMerchantAddress(),
    // x402 v1 §PaymentRequirements: `resource` MUST be a URL and
    // `description` MUST be human-readable. Wallet UIs surface
    // `description` to the user as the consent prompt.
    resource: `${process.env.NEXT_PUBLIC_BASE_URL ?? 'http://localhost:3000'}/api/a2a`,
    description: 'Per-call echo',
  },
];

// Development escape hatch: when X402_MOCK_FACILITATOR=1 the sample skips
// verify/settle entirely and returns a fake receipt. Useful for running
// the sample without an actual funded Base Sepolia wallet.
const mockFacilitator: X402Facilitator | undefined =
  process.env.X402_MOCK_FACILITATOR === '1'
    ? {
        async verify() {
          return { isValid: true, invalidReason: undefined } as Awaited<
            ReturnType<X402Facilitator['verify']>
          >;
        },
        async settle() {
          return {
            success: true,
            transaction: '0xmocktx',
            network: 'base-sepolia',
            payer: '0xmock',
          } as Awaited<ReturnType<X402Facilitator['settle']>>;
        },
      }
    : undefined;

class EchoAgent extends BaseAgent {
  private x402: X402Context;

  constructor() {
    super({
      name: 'echo_agent',
      description: 'Echoes the most recent user message back to the caller.',
    });

    this.x402 = new X402Context({
    ...(mockFacilitator
      ? { facilitator: mockFacilitator }
      : process.env.X402_FACILITATOR_URL
        ? { facilitator: { url: process.env.X402_FACILITATOR_URL } }
        : {}),
      store: new InMemoryX402Store(),
  });
  }

  async *run(ctx: InvocationContext): AsyncGenerator<AgentEvent> {
    const result = await this.x402.classify(ctx);

    switch (result.kind) {
      case 'no-submission':
        // Turn 1 — advertise the bill, store the offering for the
        // resume turn (10-minute TTL so abandoned tasks free themselves).
        yield* this.x402.requestPayment(ctx, {
          accepts: ACCEPTS,
          expiresInSeconds: 600,
        });
        return;
      case 'rejected':
      case 'no-stored-offering':
      case 'unmatched':
      case 'invalid-shape':
        // Any non-valid classification — surface the failure and stop.
        yield this.x402.failedEvent({ code: result.code, reason: result.reason });
        return;
      case 'valid':
        break;
    }

    const verify = await this.x402.verify(ctx, result);
    if (!verify.isValid) {
      yield this.x402.failedEvent({
        code: 'VERIFY_FAILED',
        reason: verify.invalidReason ?? 'Payment verification failed.',
      });
      return;
    }

    const receipt = await this.x402.settle(ctx, result);
    if (!receipt.success) {
      yield this.x402.failedEvent({
        code: 'SETTLEMENT_FAILED',
        reason: receipt.errorReason ?? 'Payment settlement failed.',
        failureReceipt: receipt,
      });
      return;
    }

    // Echo the user's text from the incoming message.
    const text = (ctx.message?.parts ?? [])
      .map((p) => ('text' in p ? p.text : ''))
      .join('');
    const utterance = text.length > 0 ? text : '(empty message)';

    await this.x402.clearOffering(ctx);
    yield { type: 'text', role: 'agent', text: `You said: ${utterance}` };
    yield this.x402.completedEvent({ receipt });
  }
}

const agent = new EchoAgent();
const runner = new InMemoryRunner({ agent, appName: 'nextjs-x402' });

const executor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
});

export const a2xAgent = new A2XAgent({
  taskStore: new InMemoryTaskStore(),
  executor,
  protocolVersion: '1.0',
  pushNotificationConfigStore: new InMemoryPushNotificationConfigStore(),
})
  .setDefaultUrl(`${process.env.BASE_URL ?? 'http://localhost:3000'}/api/a2a`)
  .addSkill({
    id: 'echo',
    name: 'Paid Echo',
    description: 'Echoes your message back — paid per call via x402.',
    tags: ['echo', 'x402', 'demo'],
  })
  .addExtension({ uri: X402_EXTENSION_URI, required: true });

export const handler = new DefaultRequestHandler(a2xAgent);
