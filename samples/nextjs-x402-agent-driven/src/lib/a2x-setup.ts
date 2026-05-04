import {
  AgentExecutor,
  A2XAgent,
  DefaultRequestHandler,
  InMemoryPushNotificationConfigStore,
  InMemoryRunner,
  InMemoryTaskStore,
  StreamingMode,
  X402_EXTENSION_URI,
  x402PaymentHook,
} from '@a2x/sdk';
import { AnthropicProvider } from '@a2x/sdk/anthropic';

import { TranslationAgent } from './translation-agent';

const MISSING_ADDRESS_PLACEHOLDER = '0x0000000000000000000000000000000000000000';

const resolveMerchantAddress = (): string => {
  const value = process.env.X402_MERCHANT_ADDRESS;
  if (!value || value.length === 0) {
    if (process.env.NEXT_PHASE !== 'phase-production-build') {
      console.warn(
        '[a2x-x402-agent-driven sample] X402_MERCHANT_ADDRESS is not set. Falling back to the zero address — premium calls will never settle until you configure a real one (.env).',
      );
    }
    return MISSING_ADDRESS_PLACEHOLDER;
  }
  return value;
};

const resolveAnthropicApiKey = (): string => {
  const value = process.env.ANTHROPIC_API_KEY;
  if (!value || value.length === 0) {
    if (process.env.NEXT_PHASE !== 'phase-production-build') {
      console.warn(
        '[a2x-x402-agent-driven sample] ANTHROPIC_API_KEY is not set. The translation agent will fail at request time. Set it in .env.',
      );
    }
    return '';
  }
  return value;
};

// USDC contract address on Base Sepolia (official Circle deployment).
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

const baseUrl = process.env.BASE_URL ?? 'http://localhost:3000';
const resourceUrl = `${process.env.NEXT_PUBLIC_BASE_URL ?? baseUrl}/api/a2a`;

const provider = new AnthropicProvider({
  model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-20250514',
  apiKey: resolveAnthropicApiKey(),
});

const agent = new TranslationAgent({
  provider,
  payment: {
    network: 'base-sepolia',
    asset: USDC_BASE_SEPOLIA,
    payTo: resolveMerchantAddress(),
    resource: resourceUrl,
  },
});

const runner = new InMemoryRunner({
  agent,
  appName: 'nextjs-x402-agent-driven',
});

// Development escape hatch: when X402_MOCK_FACILITATOR=1 the sample skips
// verify/settle entirely and returns a fake receipt. Useful for running
// the sample without an actual funded Base Sepolia wallet.
const mockFacilitator =
  process.env.X402_MOCK_FACILITATOR === '1'
    ? {
      async verify() {
        return {
          isValid: true,
          invalidReason: undefined,
          payer: '0xmock' as `0x${string}`,
        };
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

const executor = new AgentExecutor({
  runner,
  runConfig: { streamingMode: StreamingMode.SSE },
  inputRoundTripHooks: [
    x402PaymentHook({
      ...(mockFacilitator
        ? { facilitator: mockFacilitator }
        : process.env.X402_FACILITATOR_URL
          ? { facilitator: { url: process.env.X402_FACILITATOR_URL } }
          : {}),
    }),
  ],
});

export const a2xAgent = new A2XAgent({
  taskStore: new InMemoryTaskStore(),
  executor,
  protocolVersion: '1.0',
  pushNotificationConfigStore: new InMemoryPushNotificationConfigStore(),
})
  .setDefaultUrl(`${baseUrl}/api/a2a`)
  .addSkill({
    id: 'chat-and-translate',
    name: 'Chat & Translate',
    description:
      'General-purpose Claude chat. Free for any non-translation request; ' +
      'when Claude decides to call the `translate` tool, the agent raises ' +
      'payment-required and runs the tool only after settlement.',
    tags: ['translate', 'x402', 'agent-driven', 'anthropic', 'demo'],
  })
  .addExtension({ uri: X402_EXTENSION_URI, required: true });

export const handler = new DefaultRequestHandler(a2xAgent);
