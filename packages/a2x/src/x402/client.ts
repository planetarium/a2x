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
import { detectX402Version } from './versions.js';
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
 * registered with the exact EVM scheme for both protocol versions plus the
 * upto EVM scheme (V2-only), signs V1 and V2 payments —
 * `createPaymentPayload` dispatches on the requirement's version and scheme
 * and returns the structured payload directly (no base64/header round-trip;
 * that dance only exists for HTTP-header transports).
 */
interface X402ClientRuntime {
  createPaymentPayload(paymentRequired: unknown): Promise<X402PaymentPayload>;
  register(network: string, scheme: unknown): unknown;
}

type X402CoreClientModule = {
  x402Client: new () => X402ClientRuntime;
};
type X402EvmExactClientModule = {
  registerExactEvmScheme: (
    client: X402ClientRuntime,
    config: { signer: LocalAccount },
  ) => X402ClientRuntime;
};
// `@x402/evm/upto/client` ships no `registerUptoEvmScheme` counterpart (as of
// 2.19) — only the scheme class — so a2x registers it on the CAIP-2 EVM
// wildcard itself. `upto` is a V2-only scheme, so there is no `registerV1`.
type X402EvmUptoClientModule = {
  UptoEvmScheme: new (signer: LocalAccount) => unknown;
};

/** CAIP-2 wildcard `@x402/evm` registers its V2 schemes under. */
const EVM_CAIP2_WILDCARD = 'eip155:*';

/** A concrete CAIP-2 EVM network id — the only form a V2-only scheme can use. */
const CAIP2_EVM_NETWORK = /^eip155:\d+$/;

// Memoize one x402Client per signer identity — constructing the client and
// registering the scheme is not free, and callers typically reuse a signer.
const _runtimeBySigner = new WeakMap<LocalAccount, Promise<X402ClientRuntime>>();

function _loadRuntime(signer: LocalAccount): Promise<X402ClientRuntime> {
  let existing = _runtimeBySigner.get(signer);
  if (!existing) {
    existing = (async () => {
      const [core, evmExact, evmUpto] = await Promise.all([
        importX402Peer(['@x402', 'core/client'].join('/')),
        importX402Peer(['@x402', 'evm/exact/client'].join('/')),
        importX402Peer(['@x402', 'evm/upto/client'].join('/')),
      ]);
      const { x402Client } = core as unknown as X402CoreClientModule;
      const { registerExactEvmScheme } =
        evmExact as unknown as X402EvmExactClientModule;
      const { UptoEvmScheme } = evmUpto as unknown as X402EvmUptoClientModule;
      const client = new x402Client();
      // Registers BOTH versions (V2 eip155:* wildcard + V1 bare networks)
      // on the one client; createPaymentPayload then self-dispatches.
      registerExactEvmScheme(client, { signer });
      // Registering `upto` here does not make the client *choose* it — see
      // `defaultSelect`'s safety policy. It only means an explicitly selected
      // upto requirement can actually be signed.
      client.register(EVM_CAIP2_WILDCARD, new UptoEvmScheme(signer));
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
   * to sign. Default: the first EVM `exact` requirement (see
   * `allowUpto` for the usage-based fallback). Override for
   * multi-network wallets — an explicitly returned requirement is always
   * signed, whatever its scheme.
   */
  selectRequirement?: (
    requirements: X402PaymentRequirements[],
  ) => X402PaymentRequirements | undefined;
  /**
   * Let the **default** selector fall back to a CAIP-2 EVM `upto` offer when
   * the merchant advertises no payable `exact` one. Default `false`.
   *
   * Off by default deliberately: signing an `upto` offer authorizes the
   * merchant to draw **anything up to** `amount`, whereas `exact` authorizes
   * that one amount and nothing else. Silently upgrading a wallet from
   * "spend 0.01 USDC" to "spend up to 0.01 USDC, merchant decides" is a
   * change in what the payer consented to, so it is opt-in. The clamp on the
   * server side is the merchant's own guard rail, not a promise to the payer.
   *
   * Ignored when `selectRequirement` is supplied — an explicit selector has
   * already made the decision.
   */
  allowUpto?: boolean;
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
 * Read the envelope-level `extensions` the merchant advertised on a
 * `payment-required` task — the facilitator capabilities `@x402/core`'s
 * `PaymentPayloadContext` consumes (e.g. `eip2612GasSponsoring`, which lets a
 * Permit2 payer sign a gasless permit instead of an on-chain approval).
 *
 * **V2 only.** The V1 envelope has no such field, so V1 tasks (and tasks not
 * asking for payment) return `undefined`.
 */
export function getX402PaymentExtensions(
  task: Task,
): Record<string, unknown> | undefined {
  const required = getX402PaymentRequirements(task);
  if (required?.x402Version !== 2) return undefined;
  const extensions = required.extensions;
  // The envelope is remote-controlled: only hand back a real plain object so
  // callers can spread it into a context without guarding against a scalar —
  // or an array, which `typeof` alone would let through.
  return extensions && typeof extensions === 'object' && !Array.isArray(extensions)
    ? extensions
    : undefined;
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

  // Reject unsupported versions early so callers see the spec error code
  // (`invalid_x402_version`) instead of an opaque exception deep inside the
  // signing scheme. The SDK speaks x402Version 1 and 2.
  if (!detectX402Version(required)) {
    throw new X402InvalidVersionError(required.x402Version as unknown as number);
  }

  const select =
    options.selectRequirement ??
    ((reqs: X402PaymentRequirements[]) =>
      defaultSelect(reqs, { allowUpto: options.allowUpto }));
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

/**
 * The SDK's built-in requirement selection policy, shared by
 * `signX402Payment` and `A2XClient`'s standalone flow.
 *
 * **Exact-first, and never auto-pick `upto`.** Only options the signer can
 * actually fulfil are considered (EVM networks) — in a multi-rail V2 offer,
 * blindly taking the first entry would hand the signer a network it can't
 * sign, throwing deep inside `createPaymentPayload`; returning `undefined`
 * instead surfaces the clean `X402NoSupportedRequirementError`.
 *
 * `upto` is excluded unless `allowUpto` is set, because signing it authorizes
 * spending **up to** the offered amount at the merchant's discretion rather
 * than that exact amount. A wallet that would happily pay a fixed 0.01 USDC
 * has not thereby agreed to a variable charge, so the SDK refuses to make
 * that substitution on its own. With `allowUpto`, `upto` is still only a
 * *fallback*: a payable `exact` offer always wins.
 *
 * The `upto` fallback additionally requires a **CAIP-2** network. `upto` is a
 * V2-only scheme with no V1 registration in `@x402/evm`, so a bare-name
 * (V1) upto offer could only fail deep inside the signing runtime.
 *
 * @internal Not part of `@a2x/sdk/x402`'s public surface.
 */
export function defaultSelect(
  requirements: X402PaymentRequirements[],
  options?: { allowUpto?: boolean },
): X402PaymentRequirements | undefined {
  const exact = requirements.find(
    (r) => r.scheme === 'exact' && isEvmNetwork(r.network),
  );
  if (exact || !options?.allowUpto) return exact;
  return requirements.find(
    (r) => r.scheme === 'upto' && CAIP2_EVM_NETWORK.test(r.network),
  );
}
