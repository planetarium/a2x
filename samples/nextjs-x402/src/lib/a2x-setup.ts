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

const requireEnv = (name: string): string => {
  const value = process.env[name];
  if (!value || value.length === 0) {
    throw new Error(
      `${name} is required. Copy .env.example to .env and fill in the merchant address.`,
    );
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

const paymentExecutor = new X402PaymentExecutor(innerExecutor, {
  accepts: [
    {
      network: 'base-sepolia',
      // 0.001 USDC — tiny enough to be a believable per-call price on testnet.
      amount: '1000',
      asset: USDC_BASE_SEPOLIA,
      payTo: requireEnv('X402_MERCHANT_ADDRESS'),
      description: 'Per-call echo',
    },
  ],
  ...(process.env.X402_FACILITATOR_URL
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
  .setCapabilities({
    streaming: true,
    extensions: [{ uri: X402_EXTENSION_URI, required: true }],
  });

export const handler = new DefaultRequestHandler(a2xAgent);
