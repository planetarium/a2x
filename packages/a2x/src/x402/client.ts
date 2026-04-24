/**
 * Client-side x402 helpers.
 *
 * Two patterns are exposed:
 *
 *  1. `signX402Payment(task, { signer })` — primitive. Takes a
 *     `payment-required` task, selects one of the requirements, signs it
 *     with the caller's wallet, and returns the metadata the caller
 *     should attach to the follow-up message.
 *
 *  2. `X402Client` — wrapper around `A2XClient` that runs the full
 *     payment dance automatically: sendMessage → detect payment-required →
 *     sign → resubmit → return completed task.
 *
 * We accept any viem-compatible `LocalAccount` as the signer, which keeps
 * the SDK wallet-agnostic (CLI, browser wallets, HSM-backed signers etc.
 * all work via the same shape).
 */

import type { LocalAccount } from 'viem';
import { createPaymentHeader as createX402PaymentHeader } from 'x402/client';
import { safeBase64Decode } from 'x402/shared';
import { PaymentPayloadSchema } from 'x402/types';
import { A2XClient } from '../client/a2x-client.js';
import type { SendMessageParams } from '../types/jsonrpc.js';
import type { Task } from '../types/task.js';
import type { Message } from '../types/common.js';
import {
  X402_EXTENSION_URI,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
  type X402PaymentStatus,
} from './constants.js';
import {
  X402NoSupportedRequirementError,
  X402PaymentFailedError,
  X402PaymentRequiredError,
} from './errors.js';
import type {
  X402PaymentPayload,
  X402PaymentRequirements,
  X402PaymentRequiredResponse,
  X402SettleResponse,
} from './types.js';

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
 * subsequent `message/send` call.
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

  const select = options.selectRequirement ?? defaultSelect;
  const requirement = select(required.accepts);
  if (!requirement) {
    throw new X402NoSupportedRequirementError();
  }

  const header = await createX402PaymentHeader(
    options.signer as unknown as Parameters<typeof createX402PaymentHeader>[0],
    required.x402Version,
    requirement as unknown as Parameters<typeof createX402PaymentHeader>[2],
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

function defaultSelect(
  requirements: X402PaymentRequirements[],
): X402PaymentRequirements | undefined {
  return requirements.find((r) => r.scheme === 'exact') ?? requirements[0];
}

// ─── Convenience wrapper ────────────────────────────────────────────────

export interface X402ClientOptions extends SignX402PaymentOptions {
  /**
   * Optional callback invoked after the merchant asks for payment and
   * before the client signs. Useful for prompting the user to confirm.
   * Throw from the callback to abort the payment flow.
   */
  onPaymentRequired?: (required: X402PaymentRequiredResponse) => void | Promise<void>;
}

/**
 * Thin wrapper around `A2XClient` that transparently handles x402
 * payment challenges. Use when the calling code doesn't need to inspect
 * the `payment-required` task itself.
 */
export class X402Client {
  constructor(
    private readonly _client: A2XClient,
    private readonly _options: X402ClientOptions,
  ) {
    // a2a-x402 v0.2 §8: clients MUST activate the extension via the
    // `X-A2A-Extensions` header. Register on the wrapped A2XClient so
    // callers don't have to remember to pass `extensions` themselves.
    this._client.registerExtension(X402_EXTENSION_URI);
  }

  /**
   * Send a message, resolving payment if the merchant asks for it.
   * Returns the final completed (or failed) Task.
   */
  async sendMessage(params: SendMessageParams): Promise<Task> {
    const first = await this._client.sendMessage(params);
    if (first.status.state !== 'input-required') {
      return first;
    }
    const required = getX402PaymentRequirements(first);
    if (!required) {
      return first;
    }
    if (this._options.onPaymentRequired) {
      await this._options.onPaymentRequired(required);
    }

    const signed = await signX402Payment(first, this._options);
    const followup: Message = {
      ...params.message,
      messageId: cryptoRandomId(),
      taskId: first.id,
      contextId: first.contextId,
      metadata: {
        ...(params.message.metadata ?? {}),
        ...signed.metadata,
      },
    };

    const second = await this._client.sendMessage({
      ...params,
      message: followup,
    });

    const receipts = getX402Receipts(second);
    const failed = receipts.find((r) => !r.success);
    if (failed) {
      throw new X402PaymentFailedError(
        failed.errorReason ?? 'Payment failed',
        (second.status.message?.metadata as Record<string, unknown> | undefined)?.[
          X402_METADATA_KEYS.ERROR
        ] as string ?? 'UNKNOWN',
        { transaction: failed.transaction, network: failed.network },
      );
    }

    return second;
  }

  /** Access the underlying A2XClient for non-x402 operations. */
  get client(): A2XClient {
    return this._client;
  }
}

function cryptoRandomId(): string {
  // Node 18+ + modern browsers expose globalThis.crypto.randomUUID().
  return globalThis.crypto.randomUUID();
}
