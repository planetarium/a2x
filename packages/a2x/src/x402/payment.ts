/**
 * x402 server-side surface built on top of the SDK's input-required
 * round-trip primitives.
 *
 * This module is the spiritual successor to `executor.ts` (now removed).
 * Instead of wrapping `AgentExecutor` in a parallel class, agents express
 * payment gating inline by yielding `request-input` events — `executor.ts`'s
 * decision tree is split into two pieces:
 *
 *  - `x402RequestPayment()` — generator helper an agent yields from to
 *    publish the wire metadata for `payment-required`.
 *  - `x402PaymentHook()`    — `InputRoundTripHook` factory the default
 *    `AgentExecutor` consults on resume turns to verify + settle.
 *
 * Wire format is byte-identical to the prior class-based path; this is
 * purely a refactor of where the decisions live in code.
 */

import type {
  InputRoundTripHook,
  InputRoundTripOutcome,
} from '../a2x/input-roundtrip.js';
import type { AgentEvent } from '../agent/base-agent.js';
import type { InvocationContext } from '../runner/context.js';
import type { Message } from '../types/common.js';
import {
  X402_DEFAULT_TIMEOUT_SECONDS,
  X402_ERROR_CODES,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
  mapVerifyFailureToCode,
  type X402ErrorCode,
} from './constants.js';
import {
  resolveFacilitator,
  type FacilitatorUrlConfig,
} from './facilitator.js';
import type {
  X402Accept,
  X402Facilitator,
  X402PaymentPayload,
  X402PaymentRequiredResponse,
  X402PaymentRequirements,
  X402SettleResponse,
} from './types.js';

/**
 * Stable domain key the x402 hook registers under. Agents pass this
 * literal as `event.domain` on `request-input` events emitted by
 * `x402RequestPayment`; the default `AgentExecutor` looks it up in its
 * hook map to find the registered `x402PaymentHook`.
 */
export const X402_DOMAIN = 'x402' as const;

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
   * Optional carry-over of a prior failure reason. Set by the
   * `retryOnFailure` flow so the next round-trip's
   * `X402PaymentRequiredResponse.error` carries the human-readable cause.
   */
  previousError?: string;
}

/**
 * Generator helper an agent yields from to request payment. Returns an
 * `AsyncGenerator<AgentEvent>` so callers compose it with `yield*` exactly
 * like any other generator.
 *
 * ```ts
 * yield* x402RequestPayment({
 *   accepts: [{ network: 'base-sepolia', amount: '10000', ... }],
 *   description: 'Premium translation call',
 * });
 * return; // executor halts here and emits payment-required.
 * ```
 */
export async function* x402RequestPayment(
  input: X402RequestPaymentInput,
): AsyncGenerator<AgentEvent> {
  if (!input.accepts || input.accepts.length === 0) {
    throw new Error(
      'x402RequestPayment: at least one entry in `accepts` is required',
    );
  }

  const requirements: X402PaymentRequirements[] = input.accepts.map(normalizeAccept);
  const required: X402PaymentRequiredResponse = {
    x402Version: 1,
    accepts: requirements,
    ...(input.previousError ? { error: input.previousError } : {}),
  };

  yield {
    type: 'request-input',
    domain: X402_DOMAIN,
    metadata: {
      [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
      [X402_METADATA_KEYS.REQUIRED]: required,
    },
    message: input.description ?? 'Payment is required to use this service.',
    // Round-tripped on resume so the second-turn agent — and the SDK's
    // x402PaymentHook — can read the exact requirements published.
    payload: { accepts: input.accepts },
  };
}

export interface X402PaymentHookOptions {
  /**
   * Facilitator that performs on-chain verify/settle. Either a URL config
   * (uses `useFacilitator()` from x402/verify), a fully custom
   * `{ verify, settle }` pair, or omitted (default Coinbase facilitator).
   */
  facilitator?: FacilitatorUrlConfig | X402Facilitator;
  /**
   * spec §9: when true, verify/settle failure re-prompts payment-required
   * instead of terminating with `failed`. Default false.
   */
  retryOnFailure?: boolean;
}

/**
 * Build the `InputRoundTripHook` the default `AgentExecutor` consults on
 * x402 resume turns. Encapsulates the verify+settle dance the prior
 * `X402PaymentExecutor` inlined.
 */
export function x402PaymentHook(
  options: X402PaymentHookOptions = {},
): InputRoundTripHook {
  const facilitator = resolveFacilitator(options.facilitator);
  const retry = options.retryOnFailure ?? false;

  return {
    domain: X402_DOMAIN,
    async handleResume({ message, previous }): Promise<InputRoundTripOutcome> {
      const status = getPaymentStatus(message);

      // Client decided not to pay. Spec §5.4.2 + §7.1: terminate.
      if (status === X402_PAYMENT_STATUS.REJECTED) {
        return {
          resumed: false,
          terminate: {
            state: 'failed',
            reason: 'Payment was declined by the client.',
            metadata: {
              [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REJECTED,
            },
          },
        };
      }

      // Recover what the agent published on the prior turn. We trust the
      // round-trip record's payload over scraping it back off the task
      // because the record is the canonical agent intent.
      const acceptsFromPayload = readAcceptsFromPayload(previous.payload);
      const acceptsFromMetadata = readAcceptsFromMetadata(
        previous.emittedMetadata,
      );
      const accepts = acceptsFromPayload.length > 0
        ? acceptsFromPayload
        : acceptsFromMetadata;

      if (accepts.length === 0) {
        return {
          resumed: false,
          terminate: {
            state: 'failed',
            reason:
              'x402PaymentHook: prior round-trip record carries no accepts; cannot verify.',
            metadata: {
              [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.FAILED,
              [X402_METADATA_KEYS.ERROR]: X402_ERROR_CODES.INVALID_PAYLOAD,
            },
          },
        };
      }

      const acceptsRequirements: X402PaymentRequirements[] = accepts.map(
        normalizeAccept,
      );
      const priorReceipts = readPriorReceipts(previous.emittedMetadata);

      // Anything other than SUBMITTED is a malformed resume — same as the
      // pre-refactor executor path.
      if (status !== X402_PAYMENT_STATUS.SUBMITTED) {
        return failureOutcome(
          retry,
          accepts,
          X402_ERROR_CODES.INVALID_PAYLOAD,
          'Payment payload is missing or malformed.',
          {
            success: false,
            transaction: '',
            network: 'unknown',
            payer: 'unknown',
            errorReason: 'Payment payload is missing or malformed.',
          },
          priorReceipts,
        );
      }

      const payload = getPaymentPayload(message);
      const authorization = getEvmAuthorization(payload);
      if (!payload || !authorization) {
        return failureOutcome(
          retry,
          accepts,
          X402_ERROR_CODES.INVALID_PAYLOAD,
          'Payment payload is missing or malformed.',
          {
            success: false,
            transaction: '',
            network: payload?.network ?? 'unknown',
            payer: resolvePayer(payload, undefined, undefined),
            errorReason: 'Payment payload is missing or malformed.',
          },
          priorReceipts,
        );
      }

      const accepted = pickRequirement(payload, acceptsRequirements);
      const validationErr = validatePayloadAgainstRequirement(
        payload,
        accepted,
      );
      if (validationErr) {
        return failureOutcome(
          retry,
          accepts,
          validationErr.code,
          validationErr.reason,
          {
            success: false,
            transaction: '',
            network: payload.network,
            payer: resolvePayer(payload, undefined, undefined),
            errorReason: validationErr.reason,
          },
          priorReceipts,
        );
      }

      const verifyResult = await facilitator.verify(payload, accepted!);
      if (!verifyResult.isValid) {
        return failureOutcome(
          retry,
          accepts,
          mapVerifyFailureToCode(verifyResult.invalidReason),
          verifyResult.invalidReason ?? 'Payment verification failed.',
          {
            success: false,
            transaction: '',
            network: payload.network,
            payer: resolvePayer(payload, verifyResult, undefined),
            errorReason:
              verifyResult.invalidReason ?? 'Payment verification failed.',
          },
          priorReceipts,
        );
      }

      const settleResult = await facilitator.settle(payload, accepted!);
      if (!settleResult.success) {
        return failureOutcome(
          retry,
          accepts,
          X402_ERROR_CODES.SETTLEMENT_FAILED,
          settleResult.errorReason ?? 'Payment settlement failed.',
          {
            success: false,
            transaction: '',
            network: payload.network,
            payer: resolvePayer(payload, verifyResult, settleResult),
            errorReason: settleResult.errorReason ?? 'Payment settlement failed.',
          },
          priorReceipts,
        );
      }

      const receipt: X402SettleResponse = {
        success: true,
        transaction: settleResult.transaction ?? '',
        network: payload.network,
        payer: resolvePayer(payload, verifyResult, settleResult),
      };

      return {
        resumed: true,
        intermediate: {
          state: 'working',
          metadata: {
            [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.VERIFIED,
          },
        },
        data: { paid: true, receipt },
        finalMetadataPatch: {
          [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.COMPLETED,
          [X402_METADATA_KEYS.RECEIPTS]: [...priorReceipts, receipt],
        },
      };
    },
  };
}

/**
 * Read settled receipt(s) off the resume context. Convenience for agents
 * that want to surface the payment in their response or branch on
 * "have I been paid yet?".
 *
 * ```ts
 * const { paid, receipt } = readX402Settlement(context);
 * if (!paid) {
 *   yield* x402RequestPayment({ accepts: ACCEPTS });
 *   return;
 * }
 * ```
 */
export function readX402Settlement(
  context: InvocationContext,
): { paid: boolean; receipt?: X402SettleResponse } {
  const out = context.input?.outcome;
  if (!out || !out.data) return { paid: false };
  const data = out.data as { paid?: boolean; receipt?: X402SettleResponse };
  return { paid: data.paid === true, receipt: data.receipt };
}

// ─── Module-private helpers ───

function normalizeAccept(entry: X402Accept): X402PaymentRequirements {
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

interface EvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

function getEvmAuthorization(
  payload: X402PaymentPayload | undefined,
): EvmAuthorization | undefined {
  if (!payload) return undefined;
  const inner = payload.payload as unknown as { authorization?: EvmAuthorization };
  return inner && typeof inner === 'object' && 'authorization' in inner
    ? inner.authorization
    : undefined;
}

function resolvePayer(
  payload: X402PaymentPayload | undefined,
  verifyResult: { payer?: string } | undefined,
  settleResult: { payer?: string } | undefined,
): string {
  if (settleResult?.payer) return settleResult.payer;
  if (verifyResult?.payer) return verifyResult.payer;
  const authorization = getEvmAuthorization(payload);
  if (authorization?.from) return authorization.from;
  return 'unknown';
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

function pickRequirement(
  payload: X402PaymentPayload,
  accepts: X402PaymentRequirements[],
): X402PaymentRequirements | undefined {
  return accepts.find(
    (req) => req.network === payload.network && req.scheme === payload.scheme,
  );
}

function readAcceptsFromPayload(payload: unknown): X402Accept[] {
  if (!payload || typeof payload !== 'object') return [];
  const candidate = (payload as { accepts?: unknown }).accepts;
  return Array.isArray(candidate) ? (candidate as X402Accept[]) : [];
}

function readAcceptsFromMetadata(
  metadata: Record<string, unknown>,
): X402Accept[] {
  const required = metadata[X402_METADATA_KEYS.REQUIRED] as
    | { accepts?: X402PaymentRequirements[] }
    | undefined;
  if (!required || !Array.isArray(required.accepts)) return [];
  // Map back to the X402Accept-shaped subset readAcceptsFromPayload returns
  // so the caller can normalize uniformly.
  return required.accepts.map((req) => ({
    network: req.network,
    amount: req.maxAmountRequired,
    asset: req.asset,
    payTo: req.payTo,
    resource: req.resource,
    description: req.description,
    mimeType: req.mimeType,
    maxTimeoutSeconds: req.maxTimeoutSeconds,
    extra: req.extra,
    scheme: req.scheme as 'exact' | undefined,
  }));
}

function readPriorReceipts(
  metadata: Record<string, unknown>,
): X402SettleResponse[] {
  const value = metadata[X402_METADATA_KEYS.RECEIPTS];
  return Array.isArray(value) ? (value as X402SettleResponse[]) : [];
}

/**
 * Build the failure outcome shared between every error branch above.
 * `retry === true` re-issues `payment-required` with the failure reason
 * carried in `X402PaymentRequiredResponse.error`; `retry === false`
 * terminates the task with `payment-failed` + the failure receipt.
 */
function failureOutcome(
  retry: boolean,
  accepts: X402Accept[],
  code: X402ErrorCode,
  reason: string,
  receipt: X402SettleResponse,
  priorReceipts: X402SettleResponse[],
): InputRoundTripOutcome {
  if (retry) {
    const requirements = accepts.map(normalizeAccept);
    const required: X402PaymentRequiredResponse = {
      x402Version: 1,
      accepts: requirements,
      error: reason,
    };
    return {
      resumed: false,
      reissueInputRequired: {
        metadata: {
          [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.REQUIRED,
          [X402_METADATA_KEYS.REQUIRED]: required,
          [X402_METADATA_KEYS.ERROR]: code,
          [X402_METADATA_KEYS.RECEIPTS]: [...priorReceipts, receipt],
        },
        payload: { accepts },
      },
    };
  }
  return {
    resumed: false,
    terminate: {
      state: 'failed',
      reason: `Payment verification failed: ${reason}`,
      metadata: {
        [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.FAILED,
        [X402_METADATA_KEYS.ERROR]: code,
        [X402_METADATA_KEYS.RECEIPTS]: [...priorReceipts, receipt],
      },
    },
  };
}
