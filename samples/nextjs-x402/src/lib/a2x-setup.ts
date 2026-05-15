import {
  AgentExecutor,
  A2XAgent,
  BaseAgent,
  DefaultRequestHandler,
  InMemoryPushNotificationConfigStore,
  InMemoryRunner,
  InMemoryTaskStore,
  StreamingMode,
  X402_EXTENSION_URI,
  buildX402PaymentCompletedMetadata,
  buildX402PaymentFailedMetadata,
  mapVerifyFailureToCode,
  normalizeX402Accept,
  parseX402PaymentSubmission,
  pickX402Requirement,
  validateX402PayloadShape,
  x402RequestPayment,
  X402_ERROR_CODES,
  type AgentEvent,
  type X402Facilitator,
  type X402SettleResponse,
} from '@a2x/sdk';
import type { InvocationContext, X402Accept } from '@a2x/sdk';

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

async function loadFacilitator(): Promise<X402Facilitator> {
  if (mockFacilitator) return mockFacilitator;
  const { resolveFacilitator } = await import('@a2x/sdk');
  if (process.env.X402_FACILITATOR_URL) {
    return resolveFacilitator({ url: process.env.X402_FACILITATOR_URL });
  }
  return resolveFacilitator();
}

/**
 * The agent owns the entire payment flow. On the first turn it advertises
 * the accepted payment options. On the resume turn it parses the signed
 * submission, validates it against the originally-advertised offerings,
 * calls `facilitator.verify` and `facilitator.settle` directly, and
 * decides what to do with each outcome — no SDK round-trip mechanics.
 */
class EchoAgent extends BaseAgent {
  constructor(private readonly facilitator: X402Facilitator) {
    super({
      name: 'echo_agent',
      description: 'Echoes the most recent user message back to the caller.',
    });
  }

  async *run(context: InvocationContext): AsyncGenerator<AgentEvent> {
    if (!context.message) {
      yield { type: 'error', error: new Error('No incoming message on context.') };
      return;
    }

    const submission = parseX402PaymentSubmission(context.message);

    // Turn 1 — no payment submitted yet.
    if (!submission) {
      yield* x402RequestPayment({ accepts: ACCEPTS });
      return;
    }

    // Client rejected payment. Terminate the task as failed.
    if (submission.status !== 'payment-submitted') {
      yield {
        type: 'error',
        error: new Error('Client declined to pay.'),
        metadata: buildX402PaymentFailedMetadata({
          code: X402_ERROR_CODES.INVALID_PAYLOAD,
          reason: 'Client declined to pay.',
        }),
      };
      return;
    }

    if (!submission.payload) {
      yield {
        type: 'error',
        error: new Error('Payment payload missing.'),
        metadata: buildX402PaymentFailedMetadata({
          code: X402_ERROR_CODES.INVALID_PAYLOAD,
          reason: 'Payment payload missing.',
        }),
      };
      return;
    }

    // For this single-merchant sample the offered requirements are a
    // constant. A real merchant would look them up from a durable store
    // keyed by `context.taskId` so each task validates against what it
    // actually offered.
    const requirements = ACCEPTS.map(normalizeX402Accept);
    const requirement = pickX402Requirement(submission.payload, requirements);
    if (!requirement) {
      yield {
        type: 'error',
        error: new Error('No matching requirement for submitted payment.'),
        metadata: buildX402PaymentFailedMetadata({
          code: X402_ERROR_CODES.NETWORK_MISMATCH,
          reason: 'Submitted network/scheme does not match any offered option.',
        }),
      };
      return;
    }

    const issues = validateX402PayloadShape(submission.payload, requirement);
    if (issues.length > 0) {
      const first = issues[0]!;
      yield {
        type: 'error',
        error: new Error(first.reason),
        metadata: buildX402PaymentFailedMetadata({
          code: first.code,
          reason: first.reason,
        }),
      };
      return;
    }

    const verify = await this.facilitator.verify(submission.payload, requirement);
    if (!verify.isValid) {
      yield {
        type: 'error',
        error: new Error(verify.invalidReason ?? 'Payment verification failed.'),
        metadata: buildX402PaymentFailedMetadata({
          code: mapVerifyFailureToCode(verify.invalidReason),
          reason: verify.invalidReason ?? 'Payment verification failed.',
        }),
      };
      return;
    }

    const settle = await this.facilitator.settle(submission.payload, requirement);
    if (!settle.success) {
      yield {
        type: 'error',
        error: new Error(settle.errorReason ?? 'Payment settlement failed.'),
        metadata: buildX402PaymentFailedMetadata({
          code: X402_ERROR_CODES.SETTLEMENT_FAILED,
          reason: settle.errorReason ?? 'Payment settlement failed.',
        }),
      };
      return;
    }

    // Echo the user's text from the incoming message.
    const text = context.message.parts
      .map((p) => ('text' in p ? p.text : ''))
      .join('');
    const utterance = text.length > 0 ? text : '(empty message)';

    const receipt: X402SettleResponse = {
      success: true,
      transaction: settle.transaction ?? '',
      network: submission.payload.network,
      payer: submission.authorization?.from ?? settle.payer ?? 'unknown',
    };

    yield { type: 'text', role: 'agent', text: `You said: ${utterance}` };
    yield {
      type: 'done',
      metadata: buildX402PaymentCompletedMetadata({ receipt }),
    };
  }
}

const facilitator = await loadFacilitator();
const agent = new EchoAgent(facilitator);
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
