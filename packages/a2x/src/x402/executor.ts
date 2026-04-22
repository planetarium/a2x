/**
 * `X402PaymentExecutor` wraps an existing `AgentExecutor` with an x402
 * payment gate. All inbound messages are classified as either:
 *
 *  - "payment-submitted" → verify + settle on-chain, then run the inner
 *    executor with the original user content, and attach the settlement
 *    receipt to the response.
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
  X402_DEFAULT_RESOURCE,
  X402_DEFAULT_TIMEOUT_SECONDS,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
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
}

interface ResolvedConfig {
  accepts: X402PaymentRequirements[];
  facilitator: X402Facilitator;
  requiresPayment: (message: Message) => boolean;
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

    if (status !== X402_PAYMENT_STATUS.SUBMITTED) {
      applyPaymentRequiredStatus(task, this._buildRequirements());
      return task;
    }

    const payload = getPaymentPayload(message);
    const authorization = getEvmAuthorization(payload);
    if (!payload || !authorization) {
      applyFailedPaymentStatus(
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
      applyFailedPaymentStatus(
        task,
        validationErr.code,
        validationErr.reason,
        payload.network,
      );
      return task;
    }

    const verifyResult = await this._config.facilitator.verify(payload, accepted!);
    if (!verifyResult.isValid) {
      applyFailedPaymentStatus(
        task,
        X402_ERROR_CODES.VERIFY_FAILED,
        verifyResult.invalidReason ?? 'Payment verification failed.',
        payload.network,
      );
      return task;
    }

    const settleResult = await this._config.facilitator.settle(payload, accepted!);
    if (!settleResult.success) {
      applyFailedPaymentStatus(
        task,
        X402_ERROR_CODES.SETTLE_FAILED,
        settleResult.errorReason ?? 'Payment settlement failed.',
        payload.network,
      );
      return task;
    }

    const receipt: X402SettleResponse = {
      success: true,
      transaction: settleResult.transaction ?? '',
      network: payload.network,
    };

    const result = await this._inner.execute(task, message);
    attachReceipt(result, receipt);
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

    if (status !== X402_PAYMENT_STATUS.SUBMITTED) {
      applyPaymentRequiredStatus(task, this._buildRequirements());
      yield {
        taskId: task.id,
        contextId,
        status: task.status,
      };
      return;
    }

    const payload = getPaymentPayload(message);
    const authorization = getEvmAuthorization(payload);
    if (!payload || !authorization) {
      applyFailedPaymentStatus(
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
      applyFailedPaymentStatus(
        task,
        validationErr.code,
        validationErr.reason,
        payload.network,
      );
      yield { taskId: task.id, contextId, status: task.status };
      return;
    }

    const verifyResult = await this._config.facilitator.verify(payload, accepted!);
    if (!verifyResult.isValid) {
      applyFailedPaymentStatus(
        task,
        X402_ERROR_CODES.VERIFY_FAILED,
        verifyResult.invalidReason ?? 'Payment verification failed.',
        payload.network,
      );
      yield { taskId: task.id, contextId, status: task.status };
      return;
    }

    const settleResult = await this._config.facilitator.settle(payload, accepted!);
    if (!settleResult.success) {
      applyFailedPaymentStatus(
        task,
        X402_ERROR_CODES.SETTLE_FAILED,
        settleResult.errorReason ?? 'Payment settlement failed.',
        payload.network,
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

    attachReceipt(task, receipt);
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

  private _buildRequirements(): X402PaymentRequiredResponse {
    return {
      x402Version: 1,
      accepts: this._config.accepts,
    };
  }

  private _matchRequirement(
    payload: X402PaymentPayload,
  ): X402PaymentRequirements | undefined {
    return this._config.accepts.find(
      (req) => req.network === payload.network && req.scheme === payload.scheme,
    );
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
  };
}

function normalizeAccept(entry: X402Accept): X402PaymentRequirements {
  return {
    scheme: entry.scheme ?? 'exact',
    network: entry.network,
    maxAmountRequired: entry.amount,
    resource: (entry.resource ?? X402_DEFAULT_RESOURCE) as X402PaymentRequirements['resource'],
    description: entry.description ?? '',
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

function applyFailedPaymentStatus(
  task: Task,
  code: X402ErrorCode,
  reason: string,
  network: string | undefined,
): void {
  const receipt: X402SettleResponse = {
    success: false,
    transaction: '',
    network: network ?? 'unknown',
    errorReason: reason,
  };
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
        [X402_METADATA_KEYS.RECEIPTS]: [receipt],
      },
    },
  };
}

function attachReceipt(task: Task, receipt: X402SettleResponse): void {
  if (!task.status.message) {
    task.status.message = {
      messageId: `x402-${Date.now()}`,
      role: 'agent',
      parts: [{ text: '' }],
      metadata: {},
    };
  }
  const existing = (task.status.message.metadata ?? {}) as Record<string, unknown>;
  task.status.message.metadata = {
    ...existing,
    [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.COMPLETED,
    [X402_METADATA_KEYS.RECEIPTS]: [receipt],
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
        code: X402_ERROR_CODES.AMOUNT_EXCEEDED,
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
  applyFailedPaymentStatus,
  attachReceipt,
};
