/**
 * Server-side helpers for a2a-x402 payment flows.
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
 * Spec: specification/x402-transport-a2a-v1.md, -v2.md — the encoders here
 * cover both protocol versions, selected by the `x402Version` option.
 */

import type { AgentEvent } from '../agent/base-agent.js';
import type { Message } from '../types/common.js';
import {
  X402_ERROR_CODES,
  X402_METADATA_KEYS,
  X402_PAYMENT_STATUS,
  type X402ErrorCode,
} from './constants.js';
import {
  detectX402Version,
  payloadMatchesRequirement,
  requirementAmount,
  requirementPayTo,
  requirementScheme,
  type X402Version,
} from './versions.js';
import { sameNetwork } from './networks.js';
import { encodePaymentRequiredV1, encodeRequirementV1 } from './wire-v1.js';
import { encodePaymentRequiredV2 } from './wire-v2.js';
import type {
  X402Accept,
  X402EvmAuthorization,
  X402PaymentPayload,
  X402PaymentRequirements,
  X402Permit2Authorization,
  X402SettleResponse,
} from './types.js';

export type {
  X402EvmAuthorization,
  X402Permit2Authorization,
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
  /**
   * Envelope-level `extensions` advertising facilitator capabilities to the
   * client (e.g. `{ eip2612GasSponsoring: {} }`, which lets a Permit2 payer
   * sign a gasless EIP-2612 permit instead of an on-chain approval). Mirror
   * here whatever the facilitator reports as supported.
   *
   * **V2 only** — the V1 envelope has no such field, so this is a no-op
   * under `x402Version: 1`.
   */
  extensions?: Record<string, unknown>;
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
  options?: { x402Version?: X402Version },
): Record<string, unknown> {
  if (!input.accepts || input.accepts.length === 0) {
    throw new Error(
      'buildX402PaymentRequiredMetadata: at least one entry in `accepts` is required',
    );
  }
  // Defaults to V1 for backward compatibility, for direct callers that pass no
  // version. `X402Context.requestPayment` always passes the server's
  // configured x402Version explicitly.
  const x402Version = options?.x402Version ?? 1;
  const errorOpt = input.previousError ? { error: input.previousError } : {};
  const required =
    x402Version === 2
      ? encodePaymentRequiredV2(input.accepts, {
          ...errorOpt,
          ...(input.extensions ? { extensions: input.extensions } : {}),
        })
      : encodePaymentRequiredV1(input.accepts, errorOpt);
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
  options?: { x402Version?: X402Version },
): AsyncGenerator<AgentEvent> {
  yield {
    type: 'request-input',
    metadata: buildX402PaymentRequiredMetadata(input, options),
    message: input.description ?? 'Payment is required to use this service.',
  };
}

// ─── 2턴: parse submitted message ───

/**
 * Structured view of a payment message's x402 metadata. `status` reflects
 * the value of `x402.payment.status` on the incoming message; `payload`,
 * `authorization`, and `x402Version` are populated when the client submitted
 * a signed payment (status === `payment-submitted`).
 */
export interface X402PaymentSubmission {
  status: string;
  payload?: X402PaymentPayload;
  /**
   * The EIP-3009 authorization of an `exact` payload. Absent for every other
   * scheme — read `payer` instead when all you need is who signed.
   */
  authorization?: X402EvmAuthorization;
  /**
   * The Permit2 witness authorization of an `upto` payload. Absent for every
   * other scheme.
   */
  permit2Authorization?: X402Permit2Authorization;
  /**
   * Payer wallet address read off whichever signed authorization the payload
   * carries (`authorization.from` for `exact`, `permit2Authorization.from`
   * for `upto`). Scheme-agnostic — this is what receipts backfill from when
   * the facilitator omits `payer`.
   */
  payer?: string;
  /** The submitted payload's `x402Version` (1 or 2), when present. */
  x402Version?: X402Version;
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
  const permit2Authorization = extractPermit2Authorization(payload);
  const payer = payload ? extractPayer(payload) : undefined;
  const x402Version = payload ? detectX402Version(payload) : undefined;

  return {
    status,
    ...(payload ? { payload } : {}),
    ...(authorization ? { authorization } : {}),
    ...(permit2Authorization ? { permit2Authorization } : {}),
    ...(payer ? { payer } : {}),
    ...(x402Version ? { x402Version } : {}),
  };
}

/**
 * Payer wallet address carried by an EVM payload, whichever scheme signed it:
 * `authorization.from` (`exact`, EIP-3009) or `permit2Authorization.from`
 * (`upto`, Permit2 witness). Returns `undefined` when the payload carries
 * neither — the SDK never fabricates a placeholder address.
 */
export function extractX402Payer(
  payload: X402PaymentPayload | undefined,
): string | undefined {
  return payload ? extractPayer(payload) : undefined;
}

/**
 * The ceiling the payer actually signed, read off the payload:
 * `permit2Authorization.permitted.amount` (`upto`) or `authorization.value`
 * (`exact`). Returns `undefined` when the payload names no cap — callers
 * clamping a metered charge fall back to the offered requirement's amount.
 *
 * @internal Not part of `@a2x/sdk/x402`'s public surface.
 */
export function payloadAuthorizedAmount(
  payload: X402PaymentPayload | undefined,
): string | undefined {
  if (!payload) return undefined;
  const permit2 = extractPermit2Authorization(payload)?.permitted?.amount;
  if (typeof permit2 === 'string') return permit2;
  const value = extractAuthorization(payload)?.value;
  return typeof value === 'string' ? value : undefined;
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
  // V2 payloads echo the full chosen requirement under `accepted`. Use it to
  // disambiguate multi-option offerings (price tiers, or multiple assets on
  // the same network) — matching only on network+scheme would bind the
  // submission to the first same-network option and mis-validate the amount
  // or hand verify/settle the wrong asset.
  if (payload.x402Version === 2 && payload.accepted) {
    const acc = payload.accepted;
    const exact = requirements.find(
      (req) =>
        req.scheme === acc.scheme &&
        sameNetwork(req.network, acc.network) &&
        req.asset === acc.asset &&
        req.payTo === acc.payTo &&
        requirementAmount(req) === acc.amount,
    );
    if (exact) return exact;
  }
  return requirements.find((req) => payloadMatchesRequirement(payload, req));
}

export interface X402ValidationIssue {
  code: X402ErrorCode;
  reason: string;
}

/**
 * Local shape validation against the agreed-upon requirement, dispatched on
 * the requirement's `scheme`. Returns an **array of issues** (empty array =
 * no problems) so the caller can decide what to do with each — reject, log,
 * ignore for VIP users, etc.
 *
 * `exact` (EIP-3009) checks:
 *  - the payload carries an `authorization` object;
 *  - `authorization.to` equals `requirement.payTo` (case-insensitive);
 *  - `authorization.value` does not exceed the requirement's amount.
 *
 * `upto` (Permit2 witness) checks:
 *  - the payload carries a `permit2Authorization` object and a `signature`;
 *  - `witness.to` equals `requirement.payTo` (case-insensitive) — the
 *    recipient binding that stops a signature being replayed to another payee;
 *  - `permitted.token` equals `requirement.asset` (case-insensitive);
 *  - `permitted.amount` is a positive integer not exceeding the requirement's
 *    amount (a zero authorization can never fund a metered charge);
 *  - `from` (the payer) is present.
 *
 * Any other scheme falls back to the `exact` checks — the SDK has no ground
 * truth for its wire shape, and failing closed is the safe default. Override
 * `BaseX402Context.validatePayloadShape` to teach the pipeline a new scheme.
 *
 * Cryptographic / on-chain validity is **not** checked here — call
 * `facilitator.verify(payload, requirement)` for that.
 */
export function validateX402PayloadShape(
  payload: X402PaymentPayload,
  requirement: X402PaymentRequirements,
): X402ValidationIssue[] {
  if (requirementScheme(requirement) === 'upto') {
    return validateUptoPayloadShape(payload, requirement);
  }
  return validateExactPayloadShape(payload, requirement);
}

function validateExactPayloadShape(
  payload: X402PaymentPayload,
  requirement: X402PaymentRequirements,
): X402ValidationIssue[] {
  const issues: X402ValidationIssue[] = [];
  const authorization = extractAuthorization(payload);
  if (!authorization) {
    issues.push({
      code: X402_ERROR_CODES.INVALID_PAYLOAD,
      reason:
        'Payload does not carry an EIP-3009 `authorization`, which the `exact` scheme requires.',
    });
    return issues;
  }
  // `authorization` is client-controlled; guard the fields we read so a
  // malformed submission (non-string `to`/`value`) yields a clean
  // INVALID_PAYLOAD issue instead of throwing a TypeError up through classify.
  if (typeof authorization.to !== 'string' || typeof authorization.value !== 'string') {
    issues.push({
      code: X402_ERROR_CODES.INVALID_PAYLOAD,
      reason: 'Authorization is missing a string `to`/`value`.',
    });
    return issues;
  }
  const payTo = requirementPayTo(requirement);
  const maxAmount = requirementAmount(requirement);
  if (authorization.to.toLowerCase() !== payTo.toLowerCase()) {
    issues.push({
      code: X402_ERROR_CODES.INVALID_PAY_TO,
      reason: `payTo mismatch: expected ${payTo}, got ${authorization.to}.`,
    });
  }
  try {
    if (BigInt(authorization.value) > BigInt(maxAmount)) {
      issues.push({
        code: X402_ERROR_CODES.INVALID_AMOUNT,
        reason: `Amount ${authorization.value} exceeds maximum ${maxAmount}.`,
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

function validateUptoPayloadShape(
  payload: X402PaymentPayload,
  requirement: X402PaymentRequirements,
): X402ValidationIssue[] {
  const issues: X402ValidationIssue[] = [];
  const inner = payload.payload as
    | { signature?: unknown; permit2Authorization?: unknown }
    | undefined;
  const auth = extractPermit2Authorization(payload);
  if (!auth) {
    issues.push({
      code: X402_ERROR_CODES.INVALID_PAYLOAD,
      reason:
        'Payload does not carry a Permit2 `permit2Authorization`, which the `upto` scheme requires.',
    });
    return issues;
  }
  if (typeof inner?.signature !== 'string' || inner.signature.length === 0) {
    issues.push({
      code: X402_ERROR_CODES.INVALID_SIGNATURE,
      reason: 'Permit2 authorization is missing its `signature`.',
    });
  }

  // Every field below is client-controlled; read defensively so a malformed
  // submission yields a clean issue rather than a TypeError up through classify.
  const to = auth.witness?.to;
  const payTo = requirementPayTo(requirement);
  if (typeof to !== 'string') {
    issues.push({
      code: X402_ERROR_CODES.INVALID_PAY_TO,
      reason: 'Permit2 authorization is missing a string `witness.to`.',
    });
  } else if (to.toLowerCase() !== payTo.toLowerCase()) {
    // The witness is what binds the signature to *this* payee; without the
    // check a signature harvested for one merchant would settle to another.
    issues.push({
      code: X402_ERROR_CODES.INVALID_PAY_TO,
      reason: `payTo mismatch: expected ${payTo}, got ${to}.`,
    });
  }

  const token = auth.permitted?.token;
  if (typeof token !== 'string') {
    issues.push({
      code: X402_ERROR_CODES.INVALID_PAYLOAD,
      reason: 'Permit2 authorization is missing a string `permitted.token`.',
    });
  } else if (token.toLowerCase() !== requirement.asset.toLowerCase()) {
    issues.push({
      code: X402_ERROR_CODES.INVALID_PAYLOAD,
      reason: `asset mismatch: expected ${requirement.asset}, got ${token}.`,
    });
  }

  const amount = auth.permitted?.amount;
  const maxAmount = requirementAmount(requirement);
  if (typeof amount !== 'string') {
    issues.push({
      code: X402_ERROR_CODES.INVALID_AMOUNT,
      reason: 'Permit2 authorization is missing a string `permitted.amount`.',
    });
  } else {
    try {
      const authorized = BigInt(amount);
      if (authorized <= 0n) {
        // An `upto` authorization for 0 can never fund a metered charge —
        // reject it here rather than let settle clamp everything to "0".
        issues.push({
          code: X402_ERROR_CODES.INVALID_AMOUNT,
          reason: `Authorized amount ${amount} must be greater than zero.`,
        });
      } else if (authorized > BigInt(maxAmount)) {
        issues.push({
          code: X402_ERROR_CODES.INVALID_AMOUNT,
          reason: `Authorized amount ${amount} exceeds maximum ${maxAmount}.`,
        });
      }
    } catch {
      issues.push({
        code: X402_ERROR_CODES.INVALID_PAYLOAD,
        reason: 'Permit2 authorized amount is not a valid number.',
      });
    }
  }

  if (typeof auth.from !== 'string' || auth.from.length === 0) {
    issues.push({
      code: X402_ERROR_CODES.INVALID_PAYLOAD,
      reason: 'Permit2 authorization is missing the payer address `from`.',
    });
  }

  return issues;
}

/**
 * Normalize an `X402Accept` to a **V1** `X402PaymentRequirements` shape
 * (applies default scheme, mimeType, timeout, etc.). Useful when calling
 * `facilitator.verify` / `facilitator.settle` with the requirement that
 * was originally advertised to the client.
 *
 * V1-shaped for backward compatibility. For V2 offerings, the negotiation
 * layer (`X402Context`) encodes requirements through the V2 codec; direct
 * callers needing V2 use `encodeRequirementV2` from the SDK internals.
 */
export function normalizeX402Accept(
  accept: X402Accept,
): X402PaymentRequirements {
  return encodeRequirementV1(accept);
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

function extractPermit2Authorization(
  payload: X402PaymentPayload | undefined,
): X402Permit2Authorization | undefined {
  if (!payload) return undefined;
  const inner = payload.payload as unknown as {
    permit2Authorization?: X402Permit2Authorization;
  };
  if (
    !inner ||
    typeof inner !== 'object' ||
    !('permit2Authorization' in inner)
  ) {
    return undefined;
  }
  const auth = inner.permit2Authorization;
  return auth && typeof auth === 'object' ? auth : undefined;
}

function extractPayer(payload: X402PaymentPayload): string | undefined {
  const from =
    extractAuthorization(payload)?.from ??
    extractPermit2Authorization(payload)?.from;
  return typeof from === 'string' && from.length > 0 ? from : undefined;
}
