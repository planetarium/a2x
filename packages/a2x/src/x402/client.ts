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
 *     payment dance automatically: sendMessage → detect gate challenge →
 *     sign → resubmit → detect embedded challenges → sign → resubmit →
 *     … → return completed task.
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
import type { Artifact, Message } from '../types/common.js';
import { isDataPart } from '../types/common.js';
import {
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
  type X402PaymentStatus,
} from './constants.js';
import {
  X402_EMBEDDED_DATA_KEY,
} from './executor.js';
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
 * into `input-required` state via the Standalone flow. Returns
 * `undefined` if the task isn't asking for Standalone payment — callers
 * should additionally check `getEmbeddedX402Challenges` for Embedded
 * flow challenges.
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
 * One pending Embedded-flow challenge discovered on a task.
 *
 * Matches the a2a-x402 v0.2 Embedded detection path (spec §4.2): the
 * task is in `input-required` with `x402.payment.status: payment-required`
 * in `status.message.metadata` but WITHOUT `x402.payment.required`, and
 * the challenge lives inside an artifact on `task.artifacts[]`.
 */
export interface EmbeddedX402Challenge {
  /** The artifact carrying the challenge. */
  artifactId: string;
  /** Optional artifact name. */
  artifactName?: string;
  /** The x402 payment-required object parsed out of the artifact data. */
  required: X402PaymentRequiredResponse;
  /**
   * The raw data-part value. When the merchant wraps the challenge in a
   * higher-level object (e.g. an AP2 `CartMandate`) this carries the
   * full shape so callers can render order details.
   */
  data: Record<string, unknown>;
}

/**
 * Scan a task for Embedded-flow x402 challenges. Returns an empty array
 * if the task isn't asking for Embedded payment.
 *
 * Per spec §4.2 the Embedded path is triggered when the task metadata
 * has `payment-required` status without the `x402.payment.required`
 * standalone key. We additionally accept a partially-populated task
 * (e.g. a gate-less agent that emits an Embedded challenge from the
 * first event) as long as `task.artifacts[]` contains a supported shape.
 */
export function getEmbeddedX402Challenges(task: Task): EmbeddedX402Challenge[] {
  const artifacts = task.artifacts ?? [];
  const results: EmbeddedX402Challenge[] = [];
  for (const artifact of artifacts) {
    const challenge = parseEmbeddedChallenge(artifact);
    if (challenge) results.push(challenge);
  }
  return results;
}

function parseEmbeddedChallenge(artifact: Artifact): EmbeddedX402Challenge | undefined {
  for (const part of artifact.parts) {
    if (!isDataPart(part)) continue;
    const data = part.data;
    if (!data || typeof data !== 'object') continue;
    const asRecord = data as Record<string, unknown>;
    const required = findX402RequiredShape(asRecord);
    if (required) {
      return {
        artifactId: artifact.artifactId,
        artifactName: artifact.name,
        required,
        data: asRecord,
      };
    }
  }
  return undefined;
}

/**
 * Look for an `X402PaymentRequiredResponse`-shaped object anywhere in a
 * data tree. Handles both the bare embedded shape (where the SDK writes
 * under the `x402.payment.required` key) and user-supplied higher-level
 * wrappers (e.g. AP2 `payment_request.method_data[n].data`).
 */
function findX402RequiredShape(
  value: unknown,
): X402PaymentRequiredResponse | undefined {
  if (!value || typeof value !== 'object') return undefined;
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findX402RequiredShape(entry);
      if (found) return found;
    }
    return undefined;
  }
  const record = value as Record<string, unknown>;

  // Bare shape emitted by X402PaymentExecutor.
  const direct = record[X402_EMBEDDED_DATA_KEY];
  if (isX402RequiredShape(direct)) return direct;

  // Direct match — when the object itself IS an X402PaymentRequiredResponse.
  if (isX402RequiredShape(record)) return record;

  // Recurse into nested values (handles AP2 and other wrappers).
  for (const nested of Object.values(record)) {
    const found = findX402RequiredShape(nested);
    if (found) return found;
  }
  return undefined;
}

function isX402RequiredShape(value: unknown): value is X402PaymentRequiredResponse {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    v.x402Version === 1 &&
    Array.isArray(v.accepts) &&
    v.accepts.length > 0
  );
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
 * subsequent `message/send` call. Works for both Standalone and
 * Embedded challenges — when the task is in Embedded state, the first
 * embedded challenge is selected unless the caller passes `requirements`
 * explicitly via `selectRequirement`.
 */
export async function signX402Payment(
  task: Task,
  options: SignX402PaymentOptions,
): Promise<SignedX402Payment> {
  const standalone = getX402PaymentRequirements(task);
  const embedded = standalone ? [] : getEmbeddedX402Challenges(task);
  const required = standalone ?? embedded[0]?.required;
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

  const payload = await signRequirement(required.x402Version, requirement, options.signer);

  return {
    requirement,
    payload,
    metadata: {
      [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.SUBMITTED,
      [X402_METADATA_KEYS.PAYLOAD]: payload,
    },
  };
}

async function signRequirement(
  x402Version: X402PaymentRequiredResponse['x402Version'],
  requirement: X402PaymentRequirements,
  signer: LocalAccount,
): Promise<X402PaymentPayload> {
  const header = await createX402PaymentHeader(
    signer as unknown as Parameters<typeof createX402PaymentHeader>[0],
    x402Version,
    requirement as unknown as Parameters<typeof createX402PaymentHeader>[2],
  );

  // `createPaymentHeader` returns a base64-encoded PaymentPayload for HTTP
  // transports. A2A doesn't transport through headers, so we decode it
  // back to the structured object for embedding in `message.metadata`.
  const decoded = safeBase64Decode(header);
  const parsed = PaymentPayloadSchema.parse(JSON.parse(decoded));
  return parsed as unknown as X402PaymentPayload;
}

function defaultSelect(
  requirements: X402PaymentRequirements[],
): X402PaymentRequirements | undefined {
  return requirements.find((r) => r.scheme === 'exact') ?? requirements[0];
}

// ─── Convenience wrapper ────────────────────────────────────────────────

export interface X402ClientOptions extends SignX402PaymentOptions {
  /**
   * Optional callback invoked after the merchant asks for a Standalone
   * (gate) payment, before the client signs. Useful for prompting the
   * user to confirm. Throw from the callback to abort the flow.
   */
  onPaymentRequired?: (required: X402PaymentRequiredResponse) => void | Promise<void>;
  /**
   * Optional callback invoked for each Embedded-flow challenge the
   * merchant emits mid-execution. Receives the parsed challenge and the
   * full in-flight task. Throw to abort.
   */
  onEmbeddedPaymentRequired?: (
    challenge: EmbeddedX402Challenge,
    task: Task,
  ) => void | Promise<void>;
  /**
   * Cap the number of payment hops (gate + embedded) a single
   * `sendMessage` call will complete before giving up. Defaults to 8 so
   * buggy agents can't produce infinite loops.
   */
  maxPaymentHops?: number;
}

/**
 * Thin wrapper around `A2XClient` that transparently handles x402
 * payment challenges — both the Standalone gate and any Embedded-flow
 * charges emitted mid-execution. Use when the calling code doesn't need
 * to inspect the intermediate tasks itself.
 */
export class X402Client {
  constructor(
    private readonly _client: A2XClient,
    private readonly _options: X402ClientOptions,
  ) {}

  /**
   * Send a message, resolving every payment challenge the merchant
   * emits. Returns the final completed (or failed) Task.
   */
  async sendMessage(params: SendMessageParams): Promise<Task> {
    const maxHops = this._options.maxPaymentHops ?? 8;
    let task = await this._client.sendMessage(params);
    let hops = 0;

    while (task.status.state === 'input-required' && hops < maxHops) {
      task = await this._resolveChallenge(params, task);
      this._assertNotFailed(task);
      hops += 1;
    }

    this._assertNotFailed(task);
    return task;
  }

  /** Access the underlying A2XClient for non-x402 operations. */
  get client(): A2XClient {
    return this._client;
  }

  private async _resolveChallenge(
    params: SendMessageParams,
    task: Task,
  ): Promise<Task> {
    const standalone = getX402PaymentRequirements(task);
    if (standalone) {
      if (this._options.onPaymentRequired) {
        await this._options.onPaymentRequired(standalone);
      }
      const signed = await signX402Payment(task, this._options);
      return this._submit(params, task, signed.metadata);
    }

    const embedded = getEmbeddedX402Challenges(task);
    const first = embedded[0];
    if (first) {
      if (this._options.onEmbeddedPaymentRequired) {
        await this._options.onEmbeddedPaymentRequired(first, task);
      }
      const select = this._options.selectRequirement ?? defaultSelect;
      const requirement = select(first.required.accepts);
      if (!requirement) {
        throw new X402NoSupportedRequirementError();
      }
      const payload = await signRequirement(
        first.required.x402Version,
        requirement,
        this._options.signer,
      );
      const metadata = {
        [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.SUBMITTED,
        [X402_METADATA_KEYS.PAYLOAD]: payload,
      };
      return this._submit(params, task, metadata);
    }

    // Input required but no x402 challenge we recognize — surface as-is.
    return task;
  }

  private async _submit(
    params: SendMessageParams,
    task: Task,
    metadata: Record<string, unknown>,
  ): Promise<Task> {
    const followup: Message = {
      ...params.message,
      messageId: cryptoRandomId(),
      taskId: task.id,
      contextId: task.contextId,
      metadata: {
        ...(params.message.metadata ?? {}),
        ...metadata,
      },
    };
    return this._client.sendMessage({
      ...params,
      message: followup,
    });
  }

  private _assertNotFailed(task: Task): void {
    const receipts = getX402Receipts(task);
    const failed = receipts.find((r) => !r.success);
    if (failed) {
      const meta = task.status.message?.metadata as
        | Record<string, unknown>
        | undefined;
      throw new X402PaymentFailedError(
        failed.errorReason ?? 'Payment failed',
        (meta?.[X402_METADATA_KEYS.ERROR] as string | undefined) ?? 'UNKNOWN',
        { transaction: failed.transaction, network: failed.network },
      );
    }
  }
}

function cryptoRandomId(): string {
  // Node 18+ + modern browsers expose globalThis.crypto.randomUUID().
  return globalThis.crypto.randomUUID();
}
