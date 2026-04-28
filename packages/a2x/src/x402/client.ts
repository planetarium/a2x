/**
 * Client-side x402 helpers.
 *
 * The high-level Standalone Flow is built into `A2XClient` itself —
 * pass `{ x402: { signer } }` to its constructor and it transparently
 * handles `payment-required` → sign → resubmit. The helpers here are
 * the lower-level primitives those built-ins compose, exposed for
 * callers that need to drive the dance manually (e.g. inspect the
 * `payment-required` task before signing, or build their own
 * orchestration on top).
 *
 * We accept any viem-compatible `LocalAccount` as the signer, which keeps
 * the SDK wallet-agnostic (CLI, browser wallets, HSM-backed signers etc.
 * all work via the same shape).
 */

import type { LocalAccount } from 'viem';
import type { Task } from '../types/task.js';
import {
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
  type X402PaymentStatus,
} from './constants.js';
import {
  X402InvalidVersionError,
  X402NoSupportedRequirementError,
  X402PaymentRequiredError,
} from './errors.js';
import type {
  X402PaymentPayload,
  X402PaymentRequirements,
  X402PaymentRequiredResponse,
  X402SettleResponse,
} from './types.js';

// x402 is declared as an `optional` peer dep. Importing its runtime
// helpers at the top level pulls them into the `@a2x/sdk/client` chunk
// even on code paths that never touch x402, which breaks bundlers when
// users haven't installed it (issue #134). Lazy-import inside the only
// function that needs them so non-x402 consumers stay unaffected.
let _x402Runtime:
  | Promise<{
      createPaymentHeader: typeof import('x402/client').createPaymentHeader;
      safeBase64Decode: typeof import('x402/shared').safeBase64Decode;
      PaymentPayloadSchema: typeof import('x402/types').PaymentPayloadSchema;
    }>
  | undefined;
async function _loadX402Runtime() {
  if (!_x402Runtime) {
    _x402Runtime = (async () => {
      const [{ createPaymentHeader }, { safeBase64Decode }, { PaymentPayloadSchema }] =
        await Promise.all([
          import('x402/client'),
          import('x402/shared'),
          import('x402/types'),
        ]);
      return { createPaymentHeader, safeBase64Decode, PaymentPayloadSchema };
    })();
  }
  return _x402Runtime;
}

export interface SignX402PaymentOptions {
  /** viem LocalAccount (or any compatible signer with a `privateKey` + `address`). */
  signer: LocalAccount;
  /**
   * Predicate run over the merchant's `accepts[]` to pick which requirement
   * to sign. Default: the first requirement whose network+scheme is
   * "exact"/supported by the signer. Override for multi-network wallets.
   */
  selectRequirement?: (
    requirements: X402PaymentRequirements[],
  ) => X402PaymentRequirements | undefined;
}

export interface SignedX402Payment {
  /** Requirement that was signed. */
  requirement: X402PaymentRequirements;
  /** Decoded, signed payload. */
  payload: X402PaymentPayload;
  /**
   * Metadata block ready to drop onto the follow-up `message.metadata`.
   * Already populated with `x402.payment.status: payment-submitted` and
   * `x402.payment.payload: <signed>`.
   */
  metadata: Record<string, unknown>;
}

/**
 * Extract the `X402PaymentRequiredResponse` from a task the merchant put
 * into `input-required` state. Returns `undefined` if the task isn't
 * actually asking for payment.
 */
export function getX402PaymentRequirements(
  task: Task,
): X402PaymentRequiredResponse | undefined {
  const meta = (task.status.message?.metadata ?? {}) as Record<string, unknown>;
  const status = meta[X402_METADATA_KEYS.STATUS] as string | undefined;
  if (status !== X402_PAYMENT_STATUS.REQUIRED) return undefined;
  const required = meta[X402_METADATA_KEYS.REQUIRED] as
    | X402PaymentRequiredResponse
    | undefined;
  return required;
}

/**
 * Extract the payment receipts from a completed task. Returns an empty
 * array when the task never went through x402.
 */
export function getX402Receipts(task: Task): X402SettleResponse[] {
  const meta = (task.status.message?.metadata ?? {}) as Record<string, unknown>;
  const receipts = meta[X402_METADATA_KEYS.RECEIPTS];
  return Array.isArray(receipts) ? (receipts as X402SettleResponse[]) : [];
}

/**
 * Read the x402 payment status of a task's final message (if any).
 */
export function getX402Status(task: Task): X402PaymentStatus | undefined {
  const meta = (task.status.message?.metadata ?? {}) as Record<string, unknown>;
  return meta[X402_METADATA_KEYS.STATUS] as X402PaymentStatus | undefined;
}

/**
 * Sign a payment for the given `payment-required` task. Callers
 * typically use this when they want fine-grained control of the
 * subsequent `message/send` call. For a one-call API that handles the
 * full dance, configure `A2XClient` with `{ x402: { signer } }`.
 */
export async function signX402Payment(
  task: Task,
  options: SignX402PaymentOptions,
): Promise<SignedX402Payment> {
  const required = getX402PaymentRequirements(task);
  if (!required) {
    throw new X402PaymentRequiredError(
      'Task is not in a payment-required state.',
    );
  }

  // x402-v1 §6/§9: only x402Version 1 is defined. The x402 npm package
  // pins `x402Versions: [1]`; signing a non-1 requirement would let a
  // malformed/forward-versioned payload reach the wire (or crash deep
  // inside `createPaymentHeader`). Reject early so callers see the spec
  // error code (`invalid_x402_version`) instead of an opaque exception.
  if (required.x402Version !== 1) {
    throw new X402InvalidVersionError(required.x402Version as unknown as number);
  }

  const select = options.selectRequirement ?? defaultSelect;
  const requirement = select(required.accepts);
  if (!requirement) {
    throw new X402NoSupportedRequirementError();
  }

  const { createPaymentHeader, safeBase64Decode, PaymentPayloadSchema } =
    await _loadX402Runtime();

  const header = await createPaymentHeader(
    options.signer as unknown as Parameters<typeof createPaymentHeader>[0],
    required.x402Version,
    requirement as unknown as Parameters<typeof createPaymentHeader>[2],
  );

  // `createPaymentHeader` returns a base64-encoded PaymentPayload for HTTP
  // transports. A2A doesn't transport through headers, so we decode it
  // back to the structured object for embedding in `message.metadata`.
  const decoded = safeBase64Decode(header);
  const parsed = PaymentPayloadSchema.parse(JSON.parse(decoded));
  const payload = parsed as unknown as X402PaymentPayload;

  return {
    requirement,
    payload,
    metadata: {
      [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.SUBMITTED,
      [X402_METADATA_KEYS.PAYLOAD]: payload,
    },
  };
}

/**
 * Build the `payment-rejected` follow-up metadata for a task the merchant
 * left in `payment-required`. Resending the original message with this
 * metadata block (and the same `taskId` / `contextId`) tells the merchant
 * the client declined the challenge — the server-side `X402PaymentExecutor`
 * terminates the task on receipt, closing the `payment-required` round
 * trip per a2a-x402 v0.2 §5.4.2 / §7.1.
 *
 * `signX402Payment` is the "yes, here's a signed payload" half of the
 * dance; `rejectX402Payment` is the "no, not at this price" half. Throwing
 * from `onPaymentRequired` in `A2XClient` aborts locally without telling
 * the merchant — use this primitive (or return `false` from
 * `onPaymentRequired`) when you want the merchant to know.
 */
export function rejectX402Payment(task: Task): {
  metadata: Record<string, unknown>;
} {
  const required = getX402PaymentRequirements(task);
  if (!required) {
    throw new X402PaymentRequiredError(
      'Task is not in a payment-required state.',
    );
  }
  return {
    metadata: {
      [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REJECTED,
    },
  };
}

function defaultSelect(
  requirements: X402PaymentRequirements[],
): X402PaymentRequirements | undefined {
  return requirements.find((r) => r.scheme === 'exact') ?? requirements[0];
}
