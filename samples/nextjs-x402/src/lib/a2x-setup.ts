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
  type AgentEvent,
} from '@a2x/sdk';
import type { InvocationContext } from '@a2x/sdk';

/**
 * A deliberately boring agent: we're showcasing the x402 payment gate,
 * not LLM integration. The agent just echoes the last text part it
 * received along with a greeting.
 *
 * Swap in `LlmAgent` + a provider if you want a real response here.
 */
class EchoAgent extends BaseAgent {
  constructor() {
    super({
      name: 'echo_agent',
      description: 'Echoes the most recent user message back to the caller.',
    });
  }

  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    // The Runner pushes the incoming user message into session.events as a
    // text event right before invoking agent.run(). The most recent
    // user-role text event is what we want to echo.
    const last = [...context.session.events]
      .reverse()
      .find((e) => e.type === 'text' && e.role === 'user');
    const text = last && last.type === 'text' ? last.text : '(empty message)';

    yield { type: 'text', role: 'agent', text: `You said: ${text}` };
    yield { type: 'done' };
  }
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

const agent = new EchoAgent();
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
  accepts: [
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
    id: 'echo',
    name: 'Paid Echo',
    description: 'Echoes your message back — paid per call via x402.',
    tags: ['echo', 'x402', 'demo'],
  })
  .addExtension({ uri: X402_EXTENSION_URI, required: true });

export const handler = new DefaultRequestHandler(a2xAgent);
