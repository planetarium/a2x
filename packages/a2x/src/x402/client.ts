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
// Same story for `batch-settlement`: a scheme class, no register helper. Unlike
// the other two it is *stateful*, so the class takes the caller's channel
// storage — see `X402BatchSettlementOptions`.
type X402EvmBatchSettlementClientModule = {
  BatchSettlementEvmScheme: new (
    signer: LocalAccount,
    options: unknown,
  ) => unknown;
  processSettleResponse: (storage: unknown, settle: unknown) => Promise<void>;
};

/** CAIP-2 wildcard `@x402/evm` registers its V2 schemes under. */
const EVM_CAIP2_WILDCARD = 'eip155:*';

/** A concrete CAIP-2 EVM network id — the only form a V2-only scheme can use. */
const CAIP2_EVM_NETWORK = /^eip155:\d+$/;

const BATCH_SETTLEMENT_CLIENT_PEER = ['@x402', 'evm/batch-settlement/client'].join(
  '/',
);

/**
 * Persisted state of one `batch-settlement` payment channel, keyed by the
 * lowercased channel id. Structurally `@x402/evm`'s
 * `BatchSettlementClientContext`; declared here so implementing a storage
 * backend does not require importing the optional peer's types.
 */
export interface X402ChannelState {
  /** Cumulative amount charged against the channel so far. */
  chargedCumulativeAmount?: string;
  /** On-chain channel balance as last reported. */
  balance?: string;
  /** Total already claimed on-chain by the merchant. */
  totalClaimed?: string;
  /** Latest payer-signed cumulative ceiling. */
  signedMaxClaimable?: string;
  /** Payer's voucher signature for `signedMaxClaimable`. */
  signature?: `0x${string}`;
}

/**
 * Where the payer keeps `batch-settlement` channel state. Structurally
 * `@x402/evm`'s `ClientChannelStorage`.
 *
 * **This must be durable for anything longer-lived than a script.** a2x types
 * its signer as a viem `LocalAccount`, which has no `readContract`, so
 * `@x402/evm`'s on-chain channel recovery never runs — this storage is the
 * payer's *only* record that a channel exists. If it comes back empty against
 * an already-funded channel, the next request signs a **fresh deposit** into
 * it: real funds moved, on top of a balance the payer already has.
 */
export interface X402ClientChannelStorage {
  get(key: string): Promise<X402ChannelState | undefined>;
  set(key: string, state: X402ChannelState): Promise<void>;
  delete(key: string): Promise<void>;
}

/** Controls how large a deposit the payer opens a channel with. */
export interface X402BatchSettlementDepositPolicy {
  /**
   * Deposit this many times the request amount, so one funding covers many
   * calls. Must be an integer `>= 3`. Default `5`.
   */
  depositMultiplier?: number;
}

/** Inputs handed to `depositStrategy` before the payer signs a deposit. */
export interface X402BatchSettlementDepositContext {
  paymentRequirements: X402PaymentRequirements;
  channelConfig: Record<string, unknown>;
  channelId: `0x${string}`;
  clientContext: X402ChannelState;
  /** Amount this single request costs. */
  requestAmount: string;
  /** Cumulative ceiling the voucher for this request will carry. */
  maxClaimableAmount: string;
  currentBalance: string;
  /** Smallest deposit that would cover `maxClaimableAmount`. */
  minimumDepositAmount: string;
  /** What `depositPolicy` computed — the value returned if the strategy opts out. */
  depositAmount: string;
}

/**
 * Custom deposit sizing. Return an amount to override the policy, `undefined`
 * to accept it, or `false` to skip depositing and sign a voucher-only payload
 * (which the merchant rejects if the channel cannot cover it). Returning an
 * amount below `minimumDepositAmount` throws.
 */
export type X402BatchSettlementDepositStrategy = (
  context: X402BatchSettlementDepositContext,
) =>
  | string
  | bigint
  | false
  | undefined
  | Promise<string | bigint | false | undefined>;

/**
 * Opts the payer into the `batch-settlement` scheme, which pays out of a
 * pre-funded on-chain channel: the payer deposits once, then each call costs
 * only an off-chain cumulative voucher. That removes settlement from the
 * response critical path and amortizes gas across many calls.
 *
 * Supplying this object is the opt-in. The scheme is not registered without
 * it, because unlike `exact` and `upto` it cannot be constructed safely from a
 * signer alone — it needs somewhere durable to keep channel state, and
 * defaulting that to memory would put funds at risk (see
 * `X402ClientChannelStorage`).
 *
 * Registering it still does not make the SDK *choose* it — see
 * `allowBatchSettlement`.
 */
export interface X402BatchSettlementOptions {
  /**
   * Durable channel-state storage. **Required** — there is deliberately no
   * default. `@x402/evm` ships `InMemoryClientChannelStorage` and a
   * file-backed implementation under
   * `@x402/evm/batch-settlement/client/file-storage`; pass in-memory only for
   * tests and short-lived processes.
   */
  storage: X402ClientChannelStorage;
  /** Deposit sizing policy. Default: 5x the request amount. */
  depositPolicy?: X402BatchSettlementDepositPolicy;
  /** Per-deposit override, for app-specific sizing or skipping. */
  depositStrategy?: X402BatchSettlementDepositStrategy;
  /**
   * Distinguishes channels that would otherwise share an id. Two channels with
   * the same payer, merchant, and token differ only by salt, so changing it
   * opens a *new* channel rather than reusing the funded one. Default: zero.
   */
  salt?: `0x${string}`;
  /** Address authorized to sign vouchers, when it isn't the signer's own. */
  payerAuthorizer?: `0x${string}`;
  /**
   * RPC endpoint used **only** to backfill the gas-sponsoring extensions on
   * the permit2 deposit path. Channel state is never read through it, so
   * omitting it costs nothing unless the merchant offers permit2 deposits with
   * gas sponsoring.
   */
  rpcUrl?: string;
  /** Signs vouchers when that key differs from the one funding deposits. */
  voucherSigner?: LocalAccount;
}

// One runtime per signer, and — when batch-settlement is configured — per
// options object on top of that. The batch scheme closes over caller-supplied
// storage, so two configs for the same signer are genuinely different runtimes
// and must not share a cache slot.
interface RuntimeCacheEntry {
  base?: Promise<X402ClientRuntime>;
  byBatchOptions?: WeakMap<
    X402BatchSettlementOptions,
    Promise<X402ClientRuntime>
  >;
}

const _runtimeBySigner = new WeakMap<LocalAccount, RuntimeCacheEntry>();

function _buildRuntime(
  signer: LocalAccount,
  batchSettlement?: X402BatchSettlementOptions,
): Promise<X402ClientRuntime> {
  return (async () => {
    const [core, evmExact, evmUpto, evmBatch] = await Promise.all([
      importX402Peer(['@x402', 'core/client'].join('/')),
      importX402Peer(['@x402', 'evm/exact/client'].join('/')),
      importX402Peer(['@x402', 'evm/upto/client'].join('/')),
      batchSettlement
        ? importX402Peer(BATCH_SETTLEMENT_CLIENT_PEER)
        : undefined,
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
    if (batchSettlement && evmBatch) {
      const { BatchSettlementEvmScheme } =
        evmBatch as unknown as X402EvmBatchSettlementClientModule;
      // V2-only, same as `upto`, hence the wildcard and no V1 registration.
      client.register(
        EVM_CAIP2_WILDCARD,
        new BatchSettlementEvmScheme(signer, {
          storage: batchSettlement.storage,
          ...(batchSettlement.depositPolicy
            ? { depositPolicy: batchSettlement.depositPolicy }
            : {}),
          ...(batchSettlement.depositStrategy
            ? { depositStrategy: batchSettlement.depositStrategy }
            : {}),
          ...(batchSettlement.salt ? { salt: batchSettlement.salt } : {}),
          ...(batchSettlement.payerAuthorizer
            ? { payerAuthorizer: batchSettlement.payerAuthorizer }
            : {}),
          ...(batchSettlement.rpcUrl ? { rpcUrl: batchSettlement.rpcUrl } : {}),
          ...(batchSettlement.voucherSigner
            ? { voucherSigner: batchSettlement.voucherSigner }
            : {}),
        }),
      );
    }
    return client;
  })();
}

function _loadRuntime(
  signer: LocalAccount,
  batchSettlement?: X402BatchSettlementOptions,
): Promise<X402ClientRuntime> {
  let entry = _runtimeBySigner.get(signer);
  if (!entry) {
    entry = {};
    _runtimeBySigner.set(signer, entry);
  }

  const cached = batchSettlement
    ? entry.byBatchOptions?.get(batchSettlement)
    : entry.base;
  if (cached) return cached;

  const created = _buildRuntime(signer, batchSettlement);
  // Don't memoize a failure: `X402PeerMissingError` tells the operator to
  // install the peers, and in a long-running server a cached rejection
  // would keep failing after they did.
  created.catch(() => {
    if (batchSettlement) {
      if (entry.byBatchOptions?.get(batchSettlement) === created) {
        entry.byBatchOptions.delete(batchSettlement);
      }
    } else if (entry.base === created) {
      entry.base = undefined;
    }
  });

  if (batchSettlement) {
    entry.byBatchOptions ??= new WeakMap();
    entry.byBatchOptions.set(batchSettlement, created);
  } else {
    entry.base = created;
  }
  return created;
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
  /**
   * Channel storage and deposit policy for the `batch-settlement` scheme.
   * Supplying it registers the scheme so a `batch-settlement` requirement can
   * be signed at all; omitting it leaves the scheme unregistered.
   */
  batchSettlement?: X402BatchSettlementOptions;
  /**
   * Let the **default** selector fall back to a CAIP-2 EVM `batch-settlement`
   * offer when the merchant advertises no payable `exact` one. Default
   * `false`, and ignored unless `batchSettlement` is configured.
   *
   * Separate from `allowUpto` rather than folded into it because the consent
   * is different in kind. `upto` widens *how much* of an authorization the
   * merchant may draw; `batch-settlement` moves money **before** any service
   * is rendered — the payer funds a channel up front (5x the request amount by
   * default) and recovers the unspent remainder only through a cooperative
   * refund or the idle-channel path. A wallet that agreed to a variable charge
   * has not thereby agreed to a prepayment.
   *
   * Ignored when `selectRequirement` is supplied.
   */
  allowBatchSettlement?: boolean;
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
      defaultSelect(reqs, {
        allowUpto: options.allowUpto,
        allowBatchSettlement:
          options.allowBatchSettlement && options.batchSettlement !== undefined,
      }));
  const accepts = required.accepts as X402PaymentRequirements[];
  const requirement = select(accepts);
  if (!requirement) {
    throw new X402NoSupportedRequirementError();
  }

  const runtime = await _loadRuntime(options.signer, options.batchSettlement);

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
 * `batch-settlement` is excluded on the same grounds and needs its own
 * `allowBatchSettlement` — it prepays a channel rather than authorizing a
 * draw, so it is a broader consent again, not a variant of `upto`.
 *
 * Both fallbacks additionally require a **CAIP-2** network. They are V2-only
 * schemes with no V1 registration in `@x402/evm`, so a bare-name (V1) offer
 * could only fail deep inside the signing runtime.
 *
 * @internal Not part of `@a2x/sdk/x402`'s public surface.
 */
export function defaultSelect(
  requirements: X402PaymentRequirements[],
  options?: { allowUpto?: boolean; allowBatchSettlement?: boolean },
): X402PaymentRequirements | undefined {
  const exact = requirements.find(
    (r) => r.scheme === 'exact' && isEvmNetwork(r.network),
  );
  if (exact) return exact;
  const upto =
    options?.allowUpto &&
    requirements.find(
      (r) => r.scheme === 'upto' && CAIP2_EVM_NETWORK.test(r.network),
    );
  if (upto) return upto;
  // Last, deliberately: paying out of a prepaid channel is the widest consent
  // of the three, so it only wins when nothing narrower is on offer.
  if (!options?.allowBatchSettlement) return undefined;
  return requirements.find(
    (r) =>
      r.scheme === 'batch-settlement' && CAIP2_EVM_NETWORK.test(r.network),
  );
}

/**
 * Fold `batch-settlement` settlement receipts back into the payer's channel
 * storage. **Required after every paid task** — without it the payer's
 * cumulative state never advances.
 *
 * `@x402/evm` normally does this from its own HTTP client's
 * `onPaymentResponse` hook, reading the `PAYMENT-RESPONSE` header. a2x carries
 * payments over A2A task metadata and never runs that hook, so the reconcile
 * step is explicit here. Skipping it means every subsequent call re-signs an
 * identical voucher against a channel a2x still believes is unfunded — and so
 * signs a **fresh deposit** each time.
 *
 * Receipts from other schemes (and any receipt without the scheme's
 * `extra.channelState`) are ignored, so passing a whole task's receipts is
 * safe:
 *
 * ```ts
 * await reconcileX402BatchSettlement(getX402Receipts(task), { storage });
 * ```
 *
 * `A2XClient` calls this automatically when configured with
 * `x402.batchSettlement`.
 */
export async function reconcileX402BatchSettlement(
  receipts: X402SettleResponse[],
  options: { storage: X402ClientChannelStorage },
): Promise<void> {
  const relevant = receipts.filter((r) => r.success && r.extra?.channelState);
  if (relevant.length === 0) return;
  const mod = (await importX402Peer(
    BATCH_SETTLEMENT_CLIENT_PEER,
  )) as unknown as X402EvmBatchSettlementClientModule;
  for (const receipt of relevant) {
    await mod.processSettleResponse(options.storage, receipt);
  }
}
