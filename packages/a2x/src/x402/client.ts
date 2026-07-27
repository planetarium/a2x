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
import { detectGeneration } from './generations.js';
import { isEvmNetwork } from './networks.js';
import { importX402Peer } from './peer.js';
import type {
  X402PaymentPayload,
  X402PaymentRequirements,
  X402PaymentRequiredResponse,
  X402SettleResponse,
} from './types.js';

/**
 * The subset of `@x402/core`'s `x402Client` the SDK drives. One client,
 * registered with the exact EVM scheme for both generations, signs V1 and
 * V2 payments — `createPaymentPayload` dispatches on the requirement's
 * generation and returns the structured payload directly (no base64/header
 * round-trip; that dance only exists for HTTP-header transports).
 */
interface X402ClientRuntime {
  createPaymentPayload(paymentRequired: unknown): Promise<X402PaymentPayload>;
}

type X402CoreClientModule = {
  x402Client: new () => X402ClientRuntime;
};
type X402EvmClientModule = {
  registerExactEvmScheme: (
    client: X402ClientRuntime,
    config: { signer: LocalAccount },
  ) => X402ClientRuntime;
};

// Memoize one x402Client per signer identity — constructing the client and
// registering the scheme is not free, and callers typically reuse a signer.
const _runtimeBySigner = new WeakMap<LocalAccount, Promise<X402ClientRuntime>>();

function _loadRuntime(signer: LocalAccount): Promise<X402ClientRuntime> {
  let existing = _runtimeBySigner.get(signer);
  if (!existing) {
    existing = (async () => {
      const [core, evm] = await Promise.all([
        importX402Peer(['@x402', 'core/client'].join('/')),
        importX402Peer(['@x402', 'evm/exact/client'].join('/')),
      ]);
      const { x402Client } = core as unknown as X402CoreClientModule;
      const { registerExactEvmScheme } = evm as unknown as X402EvmClientModule;
      const client = new x402Client();
      // Registers BOTH generations (V2 eip155:* wildcard + V1 bare networks)
      // on the one client; createPaymentPayload then self-dispatches.
      registerExactEvmScheme(client, { signer });
      return client;
    })();
    // Don't memoize a failure: `X402PeerMissingError` tells the operator to
    // install the peers, and in a long-running server a cached rejection
    // would keep failing after they did.
    existing.catch(() => {
      if (_runtimeBySigner.get(signer) === existing) {
        _runtimeBySigner.delete(signer);
      }
    });
    _runtimeBySigner.set(signer, existing);
  }
  return existing;
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

  // Reject unsupported generations early so callers see the spec error code
  // (`invalid_x402_version`) instead of an opaque exception deep inside the
  // signing scheme. The SDK speaks x402Version 1 and 2.
  if (!detectGeneration(required)) {
    throw new X402InvalidVersionError(required.x402Version as unknown as number);
  }

  const select = options.selectRequirement ?? defaultSelect;
  const accepts = required.accepts as X402PaymentRequirements[];
  const requirement = select(accepts);
  if (!requirement) {
    throw new X402NoSupportedRequirementError();
  }

  const runtime = await _loadRuntime(options.signer);

  // Hand the client the received `payment-required` envelope with `accepts`
  // narrowed to the single selected requirement, so selection stays
  // deterministic and a2x-owned (budget / wallet networks) rather than
  // delegated to the client's scheme selector. `createPaymentPayload`
  // dispatches on `x402Version` and returns the structured payload.
  const narrowed = { ...required, accepts: [requirement] };
  const payload = await runtime.createPaymentPayload(narrowed);

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
  // Only pick an option the signer can actually fulfil (EVM `exact`). In a
  // multi-rail V2 offer, blindly taking the first `exact` and narrowing to it
  // would hand the signer a network it can't sign, throwing deep inside
  // createPaymentPayload; returning undefined instead surfaces the clean
  // X402NoSupportedRequirementError.
  return requirements.find(
    (r) => r.scheme === 'exact' && isEvmNetwork(r.network),
  );
}
