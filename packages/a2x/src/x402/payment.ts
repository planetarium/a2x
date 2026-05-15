/**
 * Server-side helpers for a2a-x402 v0.2 payment flows.
 *
 * The SDK exposes the spec's mechanics as **stateless helpers** — never as
 * a flow. Each helper does one step (parse, match, validate, build
 * response metadata). The agent composes them inside its own
 * `BaseAgent.run()` and decides:
 *
 *  - when to request payment,
 *  - what offerings were promised for a given task (the agent looks this
 *    up in its own durable store, keyed by `InvocationContext.taskId`),
 *  - which `accepts` rules to validate against,
 *  - whether failure terminates or re-prompts (`yield* x402RequestPayment`
 *    again),
 *  - what to do between `facilitator.verify` and `facilitator.settle`.
 *
 * The SDK never persists payment state, never auto-routes resume turns,
 * and never bundles verify + settle. Agents call `facilitator.verify()`
 * and `facilitator.settle()` directly.
 *
 * Spec: specification/a2a-x402-v0.2.md
 */

import type { AgentEvent } from '../agent/base-agent.js';
import type { Message } from '../types/common.js';
import {
  X402_DEFAULT_TIMEOUT_SECONDS,
  X402_ERROR_CODES,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
  type X402ErrorCode,
} from './constants.js';
import type {
  X402Accept,
  X402PaymentPayload,
  X402PaymentRequiredResponse,
  X402PaymentRequirements,
  X402SettleResponse,
} from './types.js';

// ─── 1턴: request payment ───

export interface X402RequestPaymentInput {
  /**
   * Payment options offered to the client. At least one is required.
   * The SDK publishes all of them under `x402.payment.required.accepts`;
   * the client picks one to sign.
   */
  accepts: X402Accept[];
  /**
   * Optional human-readable consent text placed on the input-required
   * task's status message parts. Wallet UIs may surface this to the user.
   */
  description?: string;
  /**
   * Optional carry-over of a prior failure reason. Set this when
   * re-prompting after a failed verify/settle so the next round-trip's
   * `X402PaymentRequiredResponse.error` carries the human-readable cause.
   */
  previousError?: string;
}

/**
 * Build the wire metadata object for a `payment-required` message. Pure
 * function — does not yield, does not mutate.
 *
 * Use this directly when you want to attach payment-required metadata to
 * a status message without going through the `x402RequestPayment`
 * generator (e.g. inside a custom retry flow).
 */
export function buildX402PaymentRequiredMetadata(
  input: X402RequestPaymentInput,
): Record<string, unknown> {
  if (!input.accepts || input.accepts.length === 0) {
    throw new Error(
      'buildX402PaymentRequiredMetadata: at least one entry in `accepts` is required',
    );
  }
  const requirements: X402PaymentRequirements[] = input.accepts.map(
    normalizeX402Accept,
  );
  const required: X402PaymentRequiredResponse = {
    x402Version: 1,
    accepts: requirements,
    ...(input.previousError ? { error: input.previousError } : {}),
  };
  return {
    [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
    [X402_METADATA_KEYS.REQUIRED]: required,
  };
}

/**
 * Generator helper an agent yields from to request payment.
 *
 * ```ts
 * yield* x402RequestPayment({
 *   accepts: [{ network: 'base-sepolia', amount: '10000', ... }],
 *   description: 'Premium translation call',
 * });
 * return;
 * ```
 */
export async function* x402RequestPayment(
  input: X402RequestPaymentInput,
): AsyncGenerator<AgentEvent> {
  yield {
    type: 'request-input',
    metadata: buildX402PaymentRequiredMetadata(input),
    message: input.description ?? 'Payment is required to use this service.',
  };
}

// ─── 2턴: parse submitted message ───

/** EVM-style authorization payload extracted from a signed payment. */
export interface X402EvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/**
 * Structured view of a payment message's x402 metadata. `status` reflects
 * the value of `x402.payment.status` on the incoming message; `payload`
 * and `authorization` are populated when the client submitted a signed
 * payment (status === `payment-submitted`).
 */
export interface X402PaymentSubmission {
  status: string;
  payload?: X402PaymentPayload;
  authorization?: X402EvmAuthorization;
}

/**
 * Read the x402 fields off an incoming message. Returns `undefined` when
 * no `x402.payment.status` key is present (i.e. the message is not part
 * of an x402 flow).
 */
export function parseX402PaymentSubmission(
  message: Message,
): X402PaymentSubmission | undefined {
  const meta = (message.metadata ?? {}) as Record<string, unknown>;
  const status = meta[X402_METADATA_KEYS.STATUS];
  if (typeof status !== 'string' || status.length === 0) return undefined;

  const payload = meta[X402_METADATA_KEYS.PAYLOAD] as
    | X402PaymentPayload
    | undefined;
  const authorization = extractAuthorization(payload);

  return {
    status,
    ...(payload ? { payload } : {}),
    ...(authorization ? { authorization } : {}),
  };
}

// ─── Helpers: matching + validation ───

/**
 * Find the requirement entry that matches the client's submitted
 * payload's network/scheme combination. Returns `undefined` when the
 * client picked an option the merchant did not advertise.
 */
export function pickX402Requirement(
  payload: X402PaymentPayload,
  requirements: X402PaymentRequirements[],
): X402PaymentRequirements | undefined {
  return requirements.find(
    (req) => req.network === payload.network && req.scheme === payload.scheme,
  );
}

export interface X402ValidationIssue {
  code: X402ErrorCode;
  reason: string;
}

/**
 * Local shape validation against the agreed-upon requirement. Returns an
 * **array of issues** (empty array = no problems) so the caller can
 * decide what to do with each — reject, log, ignore for VIP users, etc.
 *
 * Checks performed:
 *  - EVM `authorization` must be present (non-EVM payloads not yet
 *    supported by the SDK).
 *  - `authorization.to` must equal `requirement.payTo` (case-insensitive).
 *  - `authorization.value` must not exceed `requirement.maxAmountRequired`.
 *
 * Cryptographic / on-chain validity is **not** checked here — call
 * `facilitator.verify(payload, requirement)` for that.
 */
export function validateX402PayloadShape(
  payload: X402PaymentPayload,
  requirement: X402PaymentRequirements,
): X402ValidationIssue[] {
  const issues: X402ValidationIssue[] = [];
  const authorization = extractAuthorization(payload);
  if (!authorization) {
    issues.push({
      code: X402_ERROR_CODES.INVALID_PAYLOAD,
      reason: 'Non-EVM payloads are not yet supported by the SDK.',
    });
    return issues;
  }
  if (authorization.to.toLowerCase() !== requirement.payTo.toLowerCase()) {
    issues.push({
      code: X402_ERROR_CODES.INVALID_PAY_TO,
      reason: `payTo mismatch: expected ${requirement.payTo}, got ${authorization.to}.`,
    });
  }
  try {
    if (BigInt(authorization.value) > BigInt(requirement.maxAmountRequired)) {
      issues.push({
        code: X402_ERROR_CODES.INVALID_AMOUNT,
        reason: `Amount ${authorization.value} exceeds maximum ${requirement.maxAmountRequired}.`,
      });
    }
  } catch {
    issues.push({
      code: X402_ERROR_CODES.INVALID_PAYLOAD,
      reason: 'Authorization value is not a valid number.',
    });
  }
  return issues;
}

/**
 * Normalize an `X402Accept` to the spec's `X402PaymentRequirements` shape
 * (applies default scheme, mimeType, timeout, etc.). Useful when calling
 * `facilitator.verify` / `facilitator.settle` with the requirement that
 * was originally advertised to the client.
 */
export function normalizeX402Accept(
  accept: X402Accept,
): X402PaymentRequirements {
  return {
    scheme: accept.scheme ?? 'exact',
    network: accept.network,
    maxAmountRequired: accept.amount,
    resource: accept.resource as X402PaymentRequirements['resource'],
    description: accept.description,
    mimeType: accept.mimeType ?? 'application/json',
    payTo: accept.payTo,
    maxTimeoutSeconds: accept.maxTimeoutSeconds ?? X402_DEFAULT_TIMEOUT_SECONDS,
    asset: accept.asset,
    extra: accept.extra ?? { name: 'USDC', version: '2' },
  } as X402PaymentRequirements;
}

// ─── Response metadata builders ───

/**
 * Build the metadata for a successful settlement response. Pair with
 * `{ type: 'done', metadata: buildX402PaymentCompletedMetadata({...}) }`.
 *
 * `priorReceipts` lets you preserve receipts from earlier
 * verify/settle attempts on the same task — useful when an earlier
 * round-trip failed and you re-prompted the user.
 */
export function buildX402PaymentCompletedMetadata(input: {
  receipt: X402SettleResponse;
  priorReceipts?: X402SettleResponse[];
}): Record<string, unknown> {
  const allReceipts = [...(input.priorReceipts ?? []), input.receipt];
  return {
    [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.COMPLETED,
    [X402_METADATA_KEYS.RECEIPTS]: allReceipts,
  };
}

/**
 * Build the metadata for a failed payment. Pair with
 * `{ type: 'error', error: new Error(reason), metadata: buildX402PaymentFailedMetadata({...}) }`
 * to terminate the task with `failed` state.
 *
 * `failureReceipt` (optional) lets you attach a structured failure
 * receipt alongside the `RECEIPTS` array — populate this when the
 * facilitator returned a settle response with `success: false`.
 */
export function buildX402PaymentFailedMetadata(input: {
  code: X402ErrorCode;
  reason: string;
  failureReceipt?: X402SettleResponse;
  priorReceipts?: X402SettleResponse[];
}): Record<string, unknown> {
  const receipts = [
    ...(input.priorReceipts ?? []),
    ...(input.failureReceipt ? [input.failureReceipt] : []),
  ];
  const out: Record<string, unknown> = {
    [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.FAILED,
    [X402_METADATA_KEYS.ERROR]: input.code,
  };
  if (receipts.length > 0) {
    out[X402_METADATA_KEYS.RECEIPTS] = receipts;
  }
  return out;
}

/**
 * Build the metadata for a `payment-verified` intermediate status (spec
 * §7.1). Emit between `verify` succeeding and `settle` starting when you
 * want clients to see the verified-but-not-yet-settled state. Pair with
 * a streaming status update — non-streaming flows can skip this.
 */
export function buildX402PaymentVerifiedMetadata(): Record<string, unknown> {
  return {
    [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.VERIFIED,
  };
}

// ─── Module-private helpers ───

function extractAuthorization(
  payload: X402PaymentPayload | undefined,
): X402EvmAuthorization | undefined {
  if (!payload) return undefined;
  const inner = payload.payload as unknown as {
    authorization?: X402EvmAuthorization;
  };
  if (!inner || typeof inner !== 'object' || !('authorization' in inner)) {
    return undefined;
  }
  return inner.authorization;
}
