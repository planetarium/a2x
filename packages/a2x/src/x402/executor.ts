/**
 * `X402PaymentExecutor` wraps an existing `AgentExecutor` with an x402
 * payment gate. All inbound messages are classified as either:
 *
 *  - "payment-submitted" → verify + settle on-chain, then run the inner
 *    executor with the original user content, and attach the settlement
 *    receipt to the response.
 *  - "payment-rejected" → client declined the requirements; terminate the
 *    task without re-prompting (spec §5.4.2 + §7.1 rejection transition).
 *  - anything else → respond with a `payment-required` task state carrying
 *    the `X402PaymentRequiredResponse` in message metadata. The task is
 *    left in `input-required` so the client can resume it by resending the
 *    message with a signed `PaymentPayload`.
 *
 * The wrapper preserves the `AgentExecutor` public surface (runner,
 * runConfig, execute, executeStream, cancel) so it can be dropped into
 * `A2XAgent` transparently.
 */

import type { Message } from '../types/common.js';
import type {
  Task,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from '../types/task.js';
import { TaskState } from '../types/task.js';
import { AgentExecutor } from '../a2x/agent-executor.js';
import {
  X402_ERROR_CODES,
  X402_DEFAULT_TIMEOUT_SECONDS,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
  mapVerifyFailureToCode,
  type X402ErrorCode,
} from './constants.js';
import { resolveFacilitator, type FacilitatorUrlConfig } from './facilitator.js';
import type {
  X402Accept,
  X402Facilitator,
  X402PaymentPayload,
  X402PaymentRequirements,
  X402PaymentRequiredResponse,
  X402SettleResponse,
} from './types.js';

export interface X402PaymentExecutorOptions {
  /**
   * Payment options offered to the client. At least one is required.
   * The SDK publishes all of them under `x402.payment.required.accepts`;
   * the client picks one to sign.
   */
  accepts: X402Accept[];
  /**
   * Facilitator that performs on-chain verify/settle. Either a URL config
   * (uses `useFacilitator()` from x402/verify), a fully custom
   * `{ verify, settle }` pair, or omitted (default Coinbase facilitator).
   */
  facilitator?: FacilitatorUrlConfig | X402Facilitator;
  /**
   * Optional predicate: receive the incoming message and decide whether
   * to require payment. Return `false` for requests that should pass
   * through without charging. Default: always require payment.
   */
  requiresPayment?: (message: Message) => boolean;
  /**
   * When true, verify/settle failures re-issue `payment-required` on the
   * same task (keeping it in `input-required`) with the failure reason
   * carried in `X402PaymentRequiredResponse.error` per spec §5.1 / §5.3.
   * When false (default), failures terminate the task with state `failed`.
   *
   * Spec §9 explicitly allows either strategy: "the agent could leave the
   * Task state as working or request a payment requirement with
   * input-required again."
   */
  retryOnFailure?: boolean;
}

interface ResolvedConfig {
  accepts: X402PaymentRequirements[];
  facilitator: X402Facilitator;
  requiresPayment: (message: Message) => boolean;
  retryOnFailure: boolean;
}

export class X402PaymentExecutor extends AgentExecutor {
  private readonly _inner: AgentExecutor;
  private readonly _config: ResolvedConfig;

  constructor(inner: AgentExecutor, options: X402PaymentExecutorOptions) {
    super({ runner: inner.runner, runConfig: inner.runConfig });
    this._inner = inner;
    this._config = resolveOptions(options);
  }

  override async execute(task: Task, message: Message): Promise<Task> {
    if (!this._config.requiresPayment(message)) {
      return this._inner.execute(task, message);
    }

    const status = getPaymentStatus(message);

    if (status === X402_PAYMENT_STATUS.REJECTED) {
      applyRejectedStatus(task);
      return task;
    }

    if (status !== X402_PAYMENT_STATUS.SUBMITTED) {
      applyPaymentRequiredStatus(task, this._buildRequirements());
      return task;
    }

    const payload = getPaymentPayload(message);
    const authorization = getEvmAuthorization(payload);
    if (!payload || !authorization) {
      this._handlePaymentFailure(
        task,
        X402_ERROR_CODES.INVALID_PAYLOAD,
        'Payment payload is missing or malformed.',
        payload?.network,
      );
      return task;
    }

    const accepted = this._matchRequirement(payload);
    const validationErr = validatePayloadAgainstRequirement(payload, accepted);
    if (validationErr) {
      this._handlePaymentFailure(
        task,
        validationErr.code,
        validationErr.reason,
        payload.network,
      );
      return task;
    }

    const verifyResult = await this._config.facilitator.verify(payload, accepted!);
    if (!verifyResult.isValid) {
      this._handlePaymentFailure(
        task,
        mapVerifyFailureToCode(verifyResult.invalidReason),
        verifyResult.invalidReason ?? 'Payment verification failed.',
        payload.network,
      );
      return task;
    }

    // Capture receipts on the task BEFORE the inner executor rewrites
    // `task.status` (which happens in _inner.execute). Without this the
    // "complete history" guarantee from spec §7 is lost across a retry.
    const priorReceipts = getExistingReceipts(task);

    // Verified — record the intermediate state per spec §7.1 even though a
    // blocking execute() doesn't surface it to the client separately.
    applyVerifiedStatus(task);

    const settleResult = await this._config.facilitator.settle(payload, accepted!);
    if (!settleResult.success) {
      this._handlePaymentFailure(
        task,
        X402_ERROR_CODES.SETTLEMENT_FAILED,
        settleResult.errorReason ?? 'Payment settlement failed.',
        payload.network,
        priorReceipts,
      );
      return task;
    }

    const receipt: X402SettleResponse = {
      success: true,
      transaction: settleResult.transaction ?? '',
      network: payload.network,
    };

    const result = await this._inner.execute(task, message);
    attachCompletedReceipt(result, receipt, priorReceipts);
    return result;
  }

  override async *executeStream(
    task: Task,
    message: Message,
  ): AsyncGenerator<TaskStatusUpdateEvent | TaskArtifactUpdateEvent> {
    if (!this._config.requiresPayment(message)) {
      yield* this._inner.executeStream(task, message);
      return;
    }

    const contextId = task.contextId ?? task.id;
    const status = getPaymentStatus(message);

    if (status === X402_PAYMENT_STATUS.REJECTED) {
      applyRejectedStatus(task);
      yield { taskId: task.id, contextId, status: task.status };
      return;
    }

    if (status !== X402_PAYMENT_STATUS.SUBMITTED) {
      applyPaymentRequiredStatus(task, this._buildRequirements());
      yield { taskId: task.id, contextId, status: task.status };
      return;
    }

    const payload = getPaymentPayload(message);
    const authorization = getEvmAuthorization(payload);
    if (!payload || !authorization) {
      this._handlePaymentFailure(
        task,
        X402_ERROR_CODES.INVALID_PAYLOAD,
        'Payment payload is missing or malformed.',
        payload?.network,
      );
      yield { taskId: task.id, contextId, status: task.status };
      return;
    }

    const accepted = this._matchRequirement(payload);
    const validationErr = validatePayloadAgainstRequirement(payload, accepted);
    if (validationErr) {
      this._handlePaymentFailure(
        task,
        validationErr.code,
        validationErr.reason,
        payload.network,
      );
      yield { taskId: task.id, contextId, status: task.status };
      return;
    }

    // Capture receipts before verify/settle/inner-stream rewrites
    // `task.status`. Same reason as the execute() path — preserve the
    // "complete history" guarantee from spec §7.
    const priorReceipts = getExistingReceipts(task);

    const verifyResult = await this._config.facilitator.verify(payload, accepted!);
    if (!verifyResult.isValid) {
      this._handlePaymentFailure(
        task,
        mapVerifyFailureToCode(verifyResult.invalidReason),
        verifyResult.invalidReason ?? 'Payment verification failed.',
        payload.network,
        priorReceipts,
      );
      yield { taskId: task.id, contextId, status: task.status };
      return;
    }

    // Spec §7.1 lifecycle: SUBMITTED → VERIFIED → COMPLETED. Emit the
    // intermediate VERIFIED state so streaming clients can surface
    // "settling on-chain…" progress before the final receipt arrives.
    applyVerifiedStatus(task);
    yield { taskId: task.id, contextId, status: task.status };

    const settleResult = await this._config.facilitator.settle(payload, accepted!);
    if (!settleResult.success) {
      this._handlePaymentFailure(
        task,
        X402_ERROR_CODES.SETTLEMENT_FAILED,
        settleResult.errorReason ?? 'Payment settlement failed.',
        payload.network,
        priorReceipts,
      );
      yield { taskId: task.id, contextId, status: task.status };
      return;
    }

    const receipt: X402SettleResponse = {
      success: true,
      transaction: settleResult.transaction ?? '',
      network: payload.network,
    };

    let lastStatusEvent: TaskStatusUpdateEvent | undefined;
    for await (const event of this._inner.executeStream(task, message)) {
      if ('status' in event && event.status.state === TaskState.COMPLETED) {
        lastStatusEvent = event;
        continue;
      }
      yield event;
    }

    attachCompletedReceipt(task, receipt, priorReceipts);
    if (lastStatusEvent) {
      yield {
        taskId: task.id,
        contextId,
        status: task.status,
      };
    }
  }

  override async cancel(task: Task): Promise<Task> {
    return this._inner.cancel(task);
  }

  // ─── Private ───

  private _buildRequirements(
    previousError?: string,
  ): X402PaymentRequiredResponse {
    const response: X402PaymentRequiredResponse = {
      x402Version: 1,
      accepts: this._config.accepts,
    };
    if (previousError) response.error = previousError;
    return response;
  }

  private _matchRequirement(
    payload: X402PaymentPayload,
  ): X402PaymentRequirements | undefined {
    return this._config.accepts.find(
      (req) => req.network === payload.network && req.scheme === payload.scheme,
    );
  }

  /**
   * Dispatch on `retryOnFailure`: either terminate the task with `failed`
   * (default, terse) or re-issue `payment-required` with the failure
   * reason carried in the `error` field (opt-in, allows client retry).
   *
   * `explicitPrior` lets the caller pass in receipts captured before a
   * downstream step (e.g. `_inner.execute`) rewrote `task.status`. When
   * omitted, prior receipts are read from the current `task.status`.
   */
  private _handlePaymentFailure(
    task: Task,
    code: X402ErrorCode,
    reason: string,
    network: string | undefined,
    explicitPrior?: X402SettleResponse[],
  ): void {
    const receipt: X402SettleResponse = {
      success: false,
      transaction: '',
      network: network ?? 'unknown',
      errorReason: reason,
    };
    const prior = explicitPrior ?? getExistingReceipts(task);
    if (this._config.retryOnFailure) {
      applyRetryRequiredStatus(
        task,
        this._buildRequirements(reason),
        receipt,
        code,
        prior,
      );
    } else {
      applyFailedPaymentStatus(task, code, reason, receipt, prior);
    }
  }
}

// ─── Module-private helpers (exported under `__internal` for tests below) ───

function resolveOptions(options: X402PaymentExecutorOptions): ResolvedConfig {
  if (!options.accepts || options.accepts.length === 0) {
    throw new Error(
      'X402PaymentExecutor: at least one entry in `accepts` is required',
    );
  }
  return {
    accepts: options.accepts.map(normalizeAccept),
    facilitator: resolveFacilitator(options.facilitator),
    requiresPayment: options.requiresPayment ?? (() => true),
    retryOnFailure: options.retryOnFailure ?? false,
  };
}

function normalizeAccept(entry: X402Accept): X402PaymentRequirements {
  // x402 v1 §PaymentRequirements requires `resource` (URL of the
  // protected resource) and `description` (human-readable). The
  // X402Accept type now requires both at the API boundary, so this
  // mapping is a straight passthrough — no fabricated defaults.
  return {
    scheme: entry.scheme ?? 'exact',
    network: entry.network,
    maxAmountRequired: entry.amount,
    resource: entry.resource as X402PaymentRequirements['resource'],
    description: entry.description,
    mimeType: entry.mimeType ?? 'application/json',
    payTo: entry.payTo,
    maxTimeoutSeconds: entry.maxTimeoutSeconds ?? X402_DEFAULT_TIMEOUT_SECONDS,
    asset: entry.asset,
    extra: entry.extra ?? { name: 'USDC', version: '2' },
  } as X402PaymentRequirements;
}

function getPaymentStatus(message: Message): string | undefined {
  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  return meta[X402_METADATA_KEYS.STATUS] as string | undefined;
}

function getPaymentPayload(message: Message): X402PaymentPayload | undefined {
  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  return meta[X402_METADATA_KEYS.PAYLOAD] as X402PaymentPayload | undefined;
}

/** Read the prior receipts array off the task's status message metadata. */
function getExistingReceipts(task: Task): X402SettleResponse[] {
  const meta = (task.status.message?.metadata ?? {}) as Record<string, unknown>;
  const prior = meta[X402_METADATA_KEYS.RECEIPTS];
  return Array.isArray(prior) ? (prior as X402SettleResponse[]) : [];
}

function applyPaymentRequiredStatus(
  task: Task,
  requirements: X402PaymentRequiredResponse,
): void {
  task.status = {
    state: TaskState.INPUT_REQUIRED,
    timestamp: new Date().toISOString(),
    message: {
      messageId: `x402-${Date.now()}`,
      role: 'agent',
      parts: [{ text: 'Payment is required to use this service.' }],
      metadata: {
        [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
        [X402_METADATA_KEYS.REQUIRED]: requirements,
      },
    },
  };
}

/**
 * Transition to a transient "verified" state between the facilitator's
 * verify call and the subsequent settle call. Spec §7.1 state machine
 * and x402-transport-a2a-v1.md map this to task state `working` with
 * `x402.payment.status: payment-verified`.
 */
function applyVerifiedStatus(task: Task): void {
  task.status = {
    state: TaskState.WORKING,
    timestamp: new Date().toISOString(),
    message: {
      messageId: `x402-${Date.now()}`,
      role: 'agent',
      parts: [{ text: 'Payment verified. Settling on-chain…' }],
      metadata: {
        [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.VERIFIED,
      },
    },
  };
}

/**
 * Terminate the task after the client signalled `payment-rejected`. Spec
 * §7.1 transition PAYMENT_REQUIRED → PAYMENT_REJECTED; we use task state
 * `failed` to end the loop (spec doesn't mandate the exact terminal, only
 * that the loop ends).
 */
function applyRejectedStatus(task: Task): void {
  task.status = {
    state: TaskState.FAILED,
    timestamp: new Date().toISOString(),
    message: {
      messageId: `x402-${Date.now()}`,
      role: 'agent',
      parts: [{ text: 'Payment was declined by the client.' }],
      metadata: {
        [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REJECTED,
      },
    },
  };
}

function applyFailedPaymentStatus(
  task: Task,
  code: X402ErrorCode,
  reason: string,
  receipt: X402SettleResponse,
  prior: X402SettleResponse[],
): void {
  task.status = {
    state: TaskState.FAILED,
    timestamp: new Date().toISOString(),
    message: {
      messageId: `x402-${Date.now()}`,
      role: 'agent',
      parts: [{ text: `Payment verification failed: ${reason}` }],
      metadata: {
        [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.FAILED,
        [X402_METADATA_KEYS.ERROR]: code,
        [X402_METADATA_KEYS.RECEIPTS]: [...prior, receipt],
      },
    },
  };
}

/**
 * Retry variant: instead of terminating, re-publish `payment-required`
 * on the same task with the failure reason in `error`. Allows the client
 * to fix the issue (top up wallet, resign with fresh nonce, etc.) and
 * re-submit without creating a new task.
 */
function applyRetryRequiredStatus(
  task: Task,
  requirements: X402PaymentRequiredResponse,
  receipt: X402SettleResponse,
  code: X402ErrorCode,
  prior: X402SettleResponse[],
): void {
  task.status = {
    state: TaskState.INPUT_REQUIRED,
    timestamp: new Date().toISOString(),
    message: {
      messageId: `x402-${Date.now()}`,
      role: 'agent',
      parts: [
        {
          text: `Payment failed: ${receipt.errorReason ?? 'unknown error'}. Please retry.`,
        },
      ],
      metadata: {
        [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
        [X402_METADATA_KEYS.REQUIRED]: requirements,
        [X402_METADATA_KEYS.ERROR]: code,
        [X402_METADATA_KEYS.RECEIPTS]: [...prior, receipt],
      },
    },
  };
}

function attachCompletedReceipt(
  task: Task,
  receipt: X402SettleResponse,
  explicitPrior?: X402SettleResponse[],
): void {
  if (!task.status.message) {
    task.status.message = {
      messageId: `x402-${Date.now()}`,
      role: 'agent',
      parts: [{ text: '' }],
      metadata: {},
    };
  }
  const existing = (task.status.message.metadata ?? {}) as Record<string, unknown>;
  // Prefer caller-supplied prior receipts when available (the caller
  // captured them before an intermediate step rewrote `task.status`).
  // Otherwise fall back to whatever is still on the task.
  const prior =
    explicitPrior ??
    (Array.isArray(existing[X402_METADATA_KEYS.RECEIPTS])
      ? (existing[X402_METADATA_KEYS.RECEIPTS] as X402SettleResponse[])
      : []);
  task.status.message.metadata = {
    ...existing,
    [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.COMPLETED,
    [X402_METADATA_KEYS.RECEIPTS]: [...prior, receipt],
  };
}

interface EvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/**
 * Return the EIP-3009 authorization from an EVM "exact" payload, or
 * `undefined` if the payload isn't EVM-shaped (e.g. SVM payloads don't
 * carry an `authorization` block — they carry a pre-signed transaction).
 */
function getEvmAuthorization(
  payload: X402PaymentPayload | undefined,
): EvmAuthorization | undefined {
  if (!payload) return undefined;
  const inner = payload.payload as unknown as { authorization?: EvmAuthorization };
  return inner && typeof inner === 'object' && 'authorization' in inner
    ? inner.authorization
    : undefined;
}

function validatePayloadAgainstRequirement(
  payload: X402PaymentPayload,
  accepted: X402PaymentRequirements | undefined,
): { code: X402ErrorCode; reason: string } | undefined {
  if (!accepted) {
    return {
      code: X402_ERROR_CODES.NETWORK_MISMATCH,
      reason: `Network/scheme "${payload.network}/${payload.scheme}" is not accepted.`,
    };
  }
  const authorization = getEvmAuthorization(payload);
  if (!authorization) {
    return {
      code: X402_ERROR_CODES.INVALID_PAYLOAD,
      reason: 'Non-EVM payloads are not yet supported by the SDK.',
    };
  }
  if (authorization.to.toLowerCase() !== accepted.payTo.toLowerCase()) {
    return {
      code: X402_ERROR_CODES.INVALID_PAY_TO,
      reason: `payTo mismatch: expected ${accepted.payTo}, got ${authorization.to}.`,
    };
  }
  try {
    if (BigInt(authorization.value) > BigInt(accepted.maxAmountRequired)) {
      return {
        code: X402_ERROR_CODES.INVALID_AMOUNT,
        reason: `Amount ${authorization.value} exceeds maximum ${accepted.maxAmountRequired}.`,
      };
    }
  } catch {
    return {
      code: X402_ERROR_CODES.INVALID_PAYLOAD,
      reason: 'Authorization value is not a valid number.',
    };
  }
  return undefined;
}

/** @internal exported for the unit tests to exercise helper functions. */
export const __internal = {
  normalizeAccept,
  validatePayloadAgainstRequirement,
  applyPaymentRequiredStatus,
  applyVerifiedStatus,
  applyRejectedStatus,
  applyFailedPaymentStatus,
  applyRetryRequiredStatus,
  attachCompletedReceipt,
};
