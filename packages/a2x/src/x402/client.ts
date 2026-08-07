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
  X402ChannelQuarantinedError,
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
};

/** CAIP-2 wildcard `@x402/evm` registers its V2 schemes under. */
const EVM_CAIP2_WILDCARD = 'eip155:*';

/** A concrete CAIP-2 EVM network id — the only form a V2-only scheme can use. */
const CAIP2_EVM_NETWORK = /^eip155:\d+$/;

const BATCH_SETTLEMENT_CLIENT_PEER = ['@x402', 'evm/batch-settlement/client'].join(
  '/',
);

/**
 * Wire name of the batch-settlement scheme.
 *
 * @internal Not part of `@a2x/sdk/x402`'s public surface.
 */
export const BATCH_SETTLEMENT_SCHEME = 'batch-settlement';

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
  /**
   * Set (ISO 8601) when an attempt on this channel ended without a
   * trustworthy reconciliation — the voucher may be spent with no receipt
   * recorded. While present, `signX402Payment` refuses to sign against the
   * channel (`X402ChannelQuarantinedError`), so the block survives a process
   * restart rather than living only in the in-process attempt queue. The
   * `@x402/evm` peer ignores the extra keys.
   *
   * Cleared by a successful `reconcileX402BatchSettlement` fold — the repair
   * path — or manually once the operator has verified the stored state.
   */
  quarantinedAt?: string;
  /** `X402ReconciliationError.reason` recorded alongside `quarantinedAt`. */
  quarantineReason?: string;
  /**
   * The quarantined attempt's complete binding, persisted so the repair fold
   * survives a process restart: pass it as `reconcileX402BatchSettlement`'s
   * `bindings` with the receipt fetched via `tasks/get` on
   * `quarantineTaskId`. The in-memory `X402ReconciliationError` carries the
   * same pair, but it dies with the process that raised it.
   */
  quarantineBinding?: X402BatchSettlementBinding;
  /** Id of the A2A task the quarantined attempt paid. */
  quarantineTaskId?: string;
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
 *
 * `A2XClient` serializes the complete sign → submit → reconcile/quarantine
 * lifetime for batch attempts sharing this storage object in one process.
 * Low-level callers using `signX402Payment` must provide the equivalent
 * per-channel exclusion themselves. The interface has no cross-process
 * compare-and-set, so replicas sharing a backend must route each channel
 * through one writer.
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

// Stateless schemes are safe to cache per signer. Batch-settlement is not:
// its scheme closes over caller-owned storage and policy objects, which can be
// mutated between calls. Rebuilding that runtime keeps signing and later
// reconciliation on the same current configuration.
interface RuntimeCacheEntry {
  base?: Promise<X402ClientRuntime>;
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

/**
 * Assert `storage` satisfies the `X402ClientChannelStorage` contract at
 * runtime, for plain-JavaScript and unchecked configuration boundaries.
 *
 * @internal Not part of `@a2x/sdk/x402`'s public surface.
 */
export function assertUsableChannelStorage(
  storage: unknown,
): X402ClientChannelStorage {
  if (
    typeof storage !== 'object' ||
    storage === null ||
    typeof (storage as { get?: unknown }).get !== 'function' ||
    typeof (storage as { set?: unknown }).set !== 'function' ||
    typeof (storage as { delete?: unknown }).delete !== 'function'
  ) {
    throw new X402PaymentRequiredError(
      'batchSettlement.storage must provide callable get, set, and delete methods; ' +
        'the SDK does not fall back to in-memory channel storage.',
    );
  }
  return storage as X402ClientChannelStorage;
}

function _loadRuntime(
  signer: LocalAccount,
  batchSettlement?: X402BatchSettlementOptions,
): Promise<X402ClientRuntime> {
  if (batchSettlement !== undefined) {
    assertUsableChannelStorage(
      (batchSettlement as { storage?: unknown }).storage,
    );

    return _buildRuntime(signer, batchSettlement);
  }

  let entry = _runtimeBySigner.get(signer);
  if (!entry) {
    entry = {};
    _runtimeBySigner.set(signer, entry);
  }

  const cached = entry.base;
  if (cached) return cached;

  const created = _buildRuntime(signer, batchSettlement);
  // Don't memoize a failure: `X402PeerMissingError` tells the operator to
  // install the peers, and in a long-running server a cached rejection
  // would keep failing after they did.
  created.catch(() => {
    if (entry.base === created) {
      entry.base = undefined;
    }
  });

  entry.base = created;
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
  /**
   * The complete reconciliation binding for a `batch-settlement` payload:
   * what the voucher authorized plus the trusted pre-attempt channel
   * snapshot, read from `batchSettlement.storage` immediately after signing
   * (signing never writes storage, so under the caller's per-channel
   * exclusion the two observe the same state).
   *
   * Pass it to `reconcileX402BatchSettlement` as the `bindings` entry once
   * the merchant's terminal response arrives. Absent for every other scheme,
   * and for a batch payload the runtime produced without a usable voucher.
   */
  batch?: X402BatchSettlementBinding;
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
 *
 * When selecting `batch-settlement`, do not overlap this channel's complete
 * sign → submit → reconcile/quarantine sequence with another attempt. Signing
 * only reads storage; it does not reserve the next cumulative or deposit, so
 * concurrent manual attempts can each authorize a fresh deposit. `A2XClient`
 * provides this in-process exclusion automatically. Multiple processes need
 * a single channel owner or an application-level durable reservation.
 *
 * A `batch-settlement` result carries `batch` — the binding (including the
 * trusted pre-attempt snapshot) that `reconcileX402BatchSettlement` needs
 * once the merchant's terminal response arrives. Signing refuses a channel
 * whose stored state carries a quarantine marker
 * (`X402ChannelQuarantinedError`) — repair the record first.
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

  // Interpose on the scheme's storage reads for a batch attempt: the exact
  // state the signer consumed is the only trustworthy reconciliation basis,
  // and a separate read after signing could observe another process's write.
  // Validated before wrapping: the recorder is itself a well-formed storage,
  // so it must not mask a malformed caller storage past the early rejection.
  const recorder =
    requirement.scheme === BATCH_SETTLEMENT_SCHEME &&
    options.batchSettlement !== undefined
      ? createSigningReadRecorder(
          assertUsableChannelStorage(
            (options.batchSettlement as { storage?: unknown }).storage,
          ),
        )
      : undefined;
  const runtime = await _loadRuntime(
    options.signer,
    recorder !== undefined
      ? { ...options.batchSettlement!, storage: recorder.storage }
      : undefined,
  );

  // Hand the client the received `payment-required` envelope with `accepts`
  // narrowed to the single selected requirement, so selection stays
  // deterministic and a2x-owned (budget / wallet networks) rather than
  // delegated to the client's scheme selector. `createPaymentPayload`
  // dispatches on `x402Version` and returns the structured payload.
  const narrowed = { ...required, accepts: [requirement] };
  const payload = await runtime.createPaymentPayload(narrowed);

  const batch =
    recorder !== undefined
      ? await captureBatchSettlementBinding(
          payload,
          options.batchSettlement!.storage,
          recorder,
        )
      : undefined;

  return {
    requirement,
    payload,
    metadata: {
      [X402_METADATA_KEYS.STATUS]: X402_PAYMENT_STATUS.SUBMITTED,
      [X402_METADATA_KEYS.PAYLOAD]: payload,
    },
    ...(batch !== undefined ? { batch } : {}),
  };
}

/**
 * The caller's channel storage with its reads observed, so the binding can
 * carry the exact state the signing math consumed.
 *
 * Two properties are load-bearing. **First read wins**: the scheme reads a
 * channel once to choose the voucher base and deposit, and that read — not a
 * repeat performed later — is the attempt's trusted snapshot; a separate
 * post-signing read could observe another process's write and bind the
 * attempt to a state the signer never saw. **Reads are copied both ways**:
 * the scheme hands the record it read to the caller's `depositStrategy` as
 * `clientContext`, so returning the live object would let a strategy mutate
 * the caller's stored record — and the snapshot — after the signer already
 * computed its cumulative and balance from it.
 */
interface SigningReadRecorder {
  storage: X402ClientChannelStorage;
  /** First-read state per lowercased channel key; `has()` marks a read. */
  reads: Map<string, X402ChannelState | undefined>;
}

function createSigningReadRecorder(
  inner: X402ClientChannelStorage,
): SigningReadRecorder {
  const reads = new Map<string, X402ChannelState | undefined>();
  return {
    reads,
    storage: {
      async get(key) {
        const state = await inner.get(key);
        const normalized = key.toLowerCase();
        if (!reads.has(normalized)) {
          reads.set(normalized, state === undefined ? undefined : { ...state });
        }
        return state === undefined ? undefined : { ...state };
      },
      set: (key, state) => inner.set(key, state),
      delete: (key) => inner.delete(key),
    },
  };
}

/**
 * Complete a signed `batch-settlement` payload's binding with the trusted
 * pre-attempt snapshot, and refuse a quarantined channel.
 *
 * The snapshot is the reconciliation's only trusted balance/cumulative
 * source: a fold computed from it is deterministic, so a retry after a torn
 * storage write rewrites the exact same state instead of guessing from
 * whatever half-committed record the failure left behind. It is the state
 * the scheme actually read while signing (see `SigningReadRecorder`); the
 * direct read below is only the fallback for a runtime that produced a
 * voucher without touching storage.
 *
 * Both failure modes here throw before the payload is returned, i.e. before
 * anything reaches the merchant: a voucher that never leaves the process
 * moves no funds.
 */
async function captureBatchSettlementBinding(
  payload: X402PaymentPayload,
  storage: X402ClientChannelStorage,
  recorder: SigningReadRecorder,
): Promise<X402BatchSettlementBinding | undefined> {
  const partial = getX402BatchSettlementBinding(payload);
  if (!partial) return undefined;

  const key = partial.channelId.toLowerCase();
  let preAttemptState: X402ChannelState | undefined;
  if (recorder.reads.has(key)) {
    preAttemptState = recorder.reads.get(key);
  } else {
    try {
      preAttemptState = await storage.get(key);
    } catch (cause) {
      const error = new X402PaymentRequiredError(
        `Signed a batch-settlement payload for channel ${partial.channelId} but could not ` +
          'snapshot the pre-attempt channel state; refusing to hand back a payload whose ' +
          'reconciliation basis is unknown.',
      );
      (error as { cause?: unknown }).cause = cause;
      throw error;
    }
  }

  if (preAttemptState?.quarantinedAt !== undefined) {
    throw new X402ChannelQuarantinedError(
      partial.channelId,
      preAttemptState.quarantinedAt,
      preAttemptState.quarantineReason,
    );
  }

  return { ...partial, preAttemptState };
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
      r.scheme === BATCH_SETTLEMENT_SCHEME && CAIP2_EVM_NETWORK.test(r.network),
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
 * The write is a **deterministic fold**: the next channel state is computed
 * from the binding's trusted pre-attempt snapshot, the voucher's bounds, and
 * the receipt — never from whatever the storage happens to hold when the
 * fold runs. That makes it idempotent: re-running the same binding + receipt
 * rewrites the same state, which is also the repair path after a torn or
 * failed storage write (and it clears any quarantine marker on the record).
 *
 * Receipts from other schemes, malformed ones, any naming a channel outside
 * `bindings`, and any whose cumulative the matching binding cannot vouch for
 * are all ignored. A cumulative is vouched for when it stays at or below the
 * signed ceiling AND either equals `preAttemptState cumulative +
 * extra.chargedAmount` (a metered settlement) or, absent a usable
 * `chargedAmount`, equals the ceiling exactly (the unmetered lifecycle) —
 * see `parseAcceptedCumulative`. Passing a whole task's receipts is
 * therefore safe:
 *
 * ```ts
 * const signed = await signX402Payment(task, { signer, batchSettlement });
 * // …resubmit, then, on the terminal task:
 * const { applied } = await reconcileX402BatchSettlement(getX402Receipts(final), {
 *   storage,
 *   bindings: signed.batch!,
 * });
 * ```
 *
 * Returns the channel ids actually written. **An empty `applied` after a
 * settled payment is a failure, not a no-op** — the voucher is spent and
 * local state did not move, so the next call re-signs it or opens a fresh
 * deposit. `A2XClient` raises `X402ReconciliationError` in that case; a caller
 * driving this directly should treat it the same way.
 *
 * Reconciliation calls sharing one storage object are serialized per channel
 * in-process. This protects the stale-replay check only; manual callers
 * must also prevent overlapping signing/submission attempts for that channel.
 * Array bindings must name distinct channels; reconcile successive vouchers
 * on the same channel in separate calls.
 */
export async function reconcileX402BatchSettlement(
  receipts: X402SettleResponse[],
  options: {
    storage: X402ClientChannelStorage;
    /**
     * What this caller actually signed — channel, voucher ceiling, deposit —
     * plus the trusted pre-attempt snapshot. **Required.** `A2XClient` and
     * `signX402Payment` assemble it as `SignedX402Payment.batch`; a caller
     * resuming from a persisted payload combines
     * `getX402BatchSettlementBinding(payload)` with the snapshot it captured
     * when it signed.
     *
     * Every field is load-bearing. The channel id stops a merchant from
     * naming a channel belonging to a *different* merchant — ids derive from
     * public inputs, so any of them is computable. The ceiling stops the same
     * merchant inflating its *own* channel's cumulative: reporting 5000 back
     * after a 1000 voucher would make the payer's next 1000 call sign a 6000
     * cumulative and a top-up to cover it, letting the merchant claim far
     * more than the calls cost. The snapshot plus the deposit establish the
     * floor the reported balance must clear (see `foldChannelState`).
     *
     * Array entries must name distinct channels. Reconcile successive
     * vouchers on one channel separately so each attempt keeps its own
     * deposit floor and cumulative ceiling.
     */
    bindings: X402BatchSettlementBinding | readonly X402BatchSettlementBinding[];
  },
): Promise<{ applied: string[] }> {
  const allowed = new Map<string, TrustedAttemptBounds>();
  const bindings = Array.isArray(options.bindings)
    ? options.bindings
    : [options.bindings as X402BatchSettlementBinding];
  for (const binding of bindings) {
    if (!isCanonicalChannelId(binding?.channelId)) continue;
    const key = binding.channelId.toLowerCase();
    if (allowed.has(key)) {
      throw new X402PaymentRequiredError(
        `bindings must not contain the same batch-settlement channel more than once: ${binding.channelId}`,
      );
    }
    // TypeScript already requires the key, but plain-JavaScript and
    // deserialized callers can omit it — and treating omission as "fresh
    // channel" would silently drop the trusted existing balance from the
    // fold's floor. An explicit `preAttemptState: undefined` states the
    // channel had no record; an absent key states nothing, so it fails.
    if (!('preAttemptState' in (binding as object))) {
      throw new X402PaymentRequiredError(
        `bindings entry for channel ${binding.channelId} omits preAttemptState. ` +
          'Pass the channel snapshot captured when the payload was signed ' +
          '(SignedX402Payment.batch carries it), or explicitly undefined for a ' +
          'channel that had no record.',
      );
    }
    let ceiling: bigint;
    let deposit: bigint;
    try {
      ceiling = BigInt(binding.maxClaimableAmount);
      deposit =
        binding.depositAmount === undefined ? 0n : BigInt(binding.depositAmount);
    } catch {
      // A bound we cannot parse cannot bound anything — drop the binding
      // rather than fall back to an unbounded one.
      continue;
    }
    // Unlike the remote-controlled receipt, the snapshot is caller-trusted
    // input: silently coercing garbage here would corrupt the floor and base
    // the whole fold rests on, so fail loudly instead.
    const pre = binding.preAttemptState;
    let preBalance = 0n;
    if (pre?.balance !== undefined) {
      try {
        preBalance = BigInt(pre.balance);
      } catch {
        preBalance = -1n;
      }
      if (preBalance < 0n) {
        throw new X402PaymentRequiredError(
          `preAttemptState.balance for channel ${binding.channelId} is not a ` +
            'non-negative integer; the trusted balance floor cannot be computed from it.',
        );
      }
    }
    let preCumulative = 0n;
    if (pre?.chargedCumulativeAmount !== undefined) {
      try {
        preCumulative = BigInt(pre.chargedCumulativeAmount);
      } catch {
        preCumulative = -1n;
      }
      if (preCumulative < 0n) {
        throw new X402PaymentRequiredError(
          `preAttemptState.chargedCumulativeAmount for channel ${binding.channelId} is not a ` +
            'non-negative integer; the metered cumulative cannot be validated against it.',
        );
      }
    }
    allowed.set(key, {
      ceiling,
      deposit,
      pre,
      floor: preBalance + deposit,
      preCumulative,
    });
  }

  const relevant: {
    receipt: X402SettleResponse;
    key: string;
    cumulative: bigint;
    bounds: TrustedAttemptBounds;
  }[] = [];
  for (const value of receipts) {
    // The array is remote-controlled despite its public TypeScript type. Keep
    // malformed entries out of the parsing path so one `null` / primitive
    // cannot throw before a later valid receipt gets its chance to apply.
    if (
      typeof value !== 'object' ||
      value === null ||
      Array.isArray(value) ||
      (value as { success?: unknown }).success !== true
    ) {
      continue;
    }
    const receipt = value as X402SettleResponse;
    const id = channelIdOf(receipt.extra);
    if (id === undefined) continue;
    const bounds = allowed.get(id.toLowerCase());
    if (bounds === undefined) continue;
    // A settled payment must advance the signing base to a figure this
    // attempt can vouch for — see `parseAcceptedCumulative`. A receipt
    // carrying only `balance` / `totalClaimed` performs a partial update
    // that leaves `chargedCumulativeAmount` untouched — and counting that as
    // applied would mask exactly the desync `applied.length === 0` exists to
    // report.
    const cumulative = parseAcceptedCumulative(receipt.extra, bounds);
    if (cumulative === undefined) continue;
    relevant.push({
      receipt,
      key: id.toLowerCase(),
      cumulative,
      bounds,
    });
  }
  if (relevant.length === 0) return { applied: [] };
  const failures: unknown[] = [];
  const applied: string[] = [];
  for (const { receipt, key, cumulative, bounds } of relevant) {
    // Per receipt, not one try around the loop: the receipts are
    // remote-controlled, and one malformed entry must not stop a later valid
    // one from being recorded — a dropped receipt leaves the payer desynced,
    // which `@x402/evm` cannot self-heal without a chain-reading signer.
    try {
      await withChannelReconciliationLock(options.storage, key, async () => {
        const stored = await options.storage.get(key);
        const storedCumulative = parseStoredCumulative(stored);
        if (storedCumulative !== undefined && storedCumulative > cumulative) {
          // A late/replayed receipt for an older voucher must never roll the
          // payer back below a newer attempt's committed state.
          return;
        }
        // Zero authorized, nothing funded, nothing recorded: there is no
        // channel to create from this receipt. A zero-cumulative receipt for
        // an attempt that DID fund a deposit must still be written — zero
        // usage does not undo the on-chain deposit, and dropping it would
        // make the next call fund the channel again.
        if (
          storedCumulative === undefined &&
          cumulative === 0n &&
          bounds.deposit === 0n
        ) {
          return;
        }
        // Equality means the receipt was (at least partially) applied
        // already. Rewriting the fold's output is deliberate: the write is
        // deterministic, so a retry repairs a torn write — cumulative
        // committed without the balance, or vice versa — instead of having
        // to guess from the half-committed record which halves survived.
        await options.storage.set(
          key,
          foldChannelState(bounds, cumulative, receipt),
        );
        applied.push(channelIdOf(receipt.extra)!);
      });
    } catch (err) {
      failures.push(err);
    }
  }
  if (failures.length > 0) {
    throw new AggregateError(
      failures,
      `Failed to reconcile ${failures.length} of ${relevant.length} batch-settlement receipt(s).`,
    );
  }
  return { applied };
}

/** What one attempt's binding proves, parsed once for the fold. */
interface TrustedAttemptBounds {
  /** Cumulative ceiling the voucher authorized — the most a receipt may report. */
  ceiling: bigint;
  /** Deposit this attempt funded (0 for a voucher-only payload). */
  deposit: bigint;
  /** Trusted pre-attempt snapshot, `undefined` when no record existed. */
  pre: X402ChannelState | undefined;
  /** `preAttemptState.balance + deposit` — the trusted balance floor. */
  floor: bigint;
  /** `preAttemptState.chargedCumulativeAmount` — the metered charge's base. */
  preCumulative: bigint;
}

/**
 * Compute the channel state one settled attempt commits:
 * `trusted pre-attempt snapshot + binding + receipt → next state`, a pure
 * function of its inputs.
 *
 * The merchant-reported `balance` steers the payer's funding decision: at
 * `0` — or absent — the scheme treats the channel as unfunded and signs a
 * **fresh deposit**, so it is a funds-moving field and cannot be trusted
 * below the floor this attempt establishes. Within a payment flow the
 * balance only ever goes **up**, by exactly the deposits this payer signs
 * (claims move `totalClaimed`; only the refund path — which a2x does not
 * drive — reduces it), so the floor is the snapshot balance plus this
 * attempt's deposit, and anything below it is a figure the merchant could
 * not have arrived at honestly. A value *above* the floor is kept: it can
 * only make the payer under-fund a later call, which costs the payer
 * nothing — the merchant simply cannot claim against funds that were never
 * deposited.
 *
 * Mirrors the write set of `@x402/evm`'s own `processSettleResponse`
 * (`chargedCumulativeAmount`, `balance`, `totalClaimed`), except that the
 * base is the trusted snapshot rather than the record currently in storage,
 * the cumulative is the accepted figure `parseAcceptedCumulative` already
 * bounded, and the balance floor comes from the binding rather than the
 * merchant. Quarantine markers never survive a successful fold.
 */
function foldChannelState(
  bounds: TrustedAttemptBounds,
  cumulative: bigint,
  receipt: X402SettleResponse,
): X402ChannelState {
  const channelState = (receipt.extra?.channelState ?? {}) as Record<
    string,
    unknown
  >;
  const {
    quarantinedAt: _quarantinedAt,
    quarantineReason: _quarantineReason,
    quarantineBinding: _quarantineBinding,
    quarantineTaskId: _quarantineTaskId,
    ...pre
  } = bounds.pre ?? {};

  let reported: bigint | undefined;
  const raw = channelState.balance;
  if (typeof raw === 'string' || typeof raw === 'number') {
    try {
      reported = BigInt(String(raw));
    } catch {
      reported = undefined;
    }
  }
  const balance =
    reported !== undefined && reported > bounds.floor ? reported : bounds.floor;

  const next: X402ChannelState = {
    ...pre,
    chargedCumulativeAmount: cumulative.toString(),
    balance: balance.toString(),
  };
  // `totalClaimed` only mirrors the merchant's on-chain claims for
  // observability; the scheme funds and signs off `balance` and the
  // cumulative alone, so the reported figure is carried when parseable and
  // the snapshot's retained otherwise.
  const totalClaimed = channelState.totalClaimed;
  if (typeof totalClaimed === 'string' || typeof totalClaimed === 'number') {
    try {
      const value = BigInt(String(totalClaimed));
      if (value >= 0n) next.totalClaimed = value.toString();
    } catch {
      // Keep the snapshot's figure.
    }
  }
  return next;
}

const _reconciliationQueues = new WeakMap<
  X402ClientChannelStorage,
  Map<string, Promise<void>>
>();

/** Serialize read-check-write reconciliation for one in-process channel. */
async function withChannelReconciliationLock<T>(
  storage: X402ClientChannelStorage,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  let queues = _reconciliationQueues.get(storage);
  if (!queues) {
    queues = new Map();
    _reconciliationQueues.set(storage, queues);
  }

  const previous = queues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  queues.set(key, current);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (queues.get(key) === current) queues.delete(key);
  }
}

/** A channel id is the EIP-712 hash of the channel config — a bytes32 hex. */
const CANONICAL_CHANNEL_ID = /^0x[0-9a-fA-F]{64}$/;

/** True for a well-formed `bytes32` channel id. */
function isCanonicalChannelId(id: unknown): id is string {
  return typeof id === 'string' && CANONICAL_CHANNEL_ID.test(id);
}

/**
 * The `channelState.channelId` on a receipt, when it is a canonical one.
 *
 * The peer keys storage on `channelState.channelId.toLowerCase()` with no
 * guard of its own, so a merchant sending `channelState: {}` (or a numeric id)
 * would throw a bare `TypeError` from inside it. Requiring the canonical
 * `bytes32` form also stops a near-miss id — differing only by padding or a
 * stray prefix — from being written as a second, orphaned storage key.
 */
function channelIdOf(
  extra: Record<string, unknown> | undefined,
): string | undefined {
  const channelState = extra?.channelState;
  if (typeof channelState !== 'object' || channelState === null) return undefined;
  const id = (channelState as { channelId?: unknown }).channelId;
  return isCanonicalChannelId(id) ? id : undefined;
}

/**
 * Parse a receipt cumulative when this attempt can vouch for it, returning
 * the figure the fold must commit.
 *
 * The cumulative must be **present** and usable. The peer writes only the keys
 * it finds, so a receipt carrying just `balance` / `totalClaimed` performs a
 * partial write that leaves `chargedCumulativeAmount` where it was — the payer
 * then re-signs the same voucher next call. For a settled payment that is a
 * desync, not a valid no-op, so such a receipt is refused rather than counted.
 *
 * Two settlement shapes are honest, and each is validated against the
 * attempt's trusted bounds:
 *
 * - **Metered** — the receipt carries `extra.chargedAmount`, the per-call
 *   service charge. a2x's own server meters batch calls via
 *   `X402Context.settle({ amountAtomic })`: verify pins the voucher ceiling
 *   to `base + offered amount`, while settle advances the server cumulative
 *   by only the metered charge, so the receipt legitimately reports
 *   `pre-attempt cumulative + chargedAmount` — anywhere up to the ceiling.
 *   The receipt is accepted only when it reports **exactly** that sum: the
 *   cross-field equation ties the merchant's two figures to the trusted
 *   snapshot, and the ceiling still caps it.
 * - **Unmetered** — no usable `chargedAmount`. The peer's plain lifecycle
 *   advances by the full requirement amount, which verify pinned to the
 *   ceiling, so the receipt must report the ceiling exactly.
 *
 * Anything else is refused: a figure above the ceiling was never authorized
 * (reporting 5000 after a 1000 voucher would make the payer's next call sign
 * an inflated cumulative plus a top-up to cover it), and an unmetered figure
 * below it would let an old receipt satisfy a new exchange or let a merchant
 * retain a higher-value voucher while keeping the payer's signing base
 * stale. Whether an accepted receipt is an idempotent retry is checked
 * immediately before the storage write, where the current state is
 * available.
 */
function parseAcceptedCumulative(
  extra: Record<string, unknown> | undefined,
  bounds: TrustedAttemptBounds,
): bigint | undefined {
  const channelState = extra?.channelState as
    | { chargedCumulativeAmount?: unknown }
    | undefined;
  const reported = channelState?.chargedCumulativeAmount;
  if (reported === undefined || reported === null) return undefined;
  if (typeof reported !== 'string' && typeof reported !== 'number') return undefined;
  let value: bigint;
  try {
    value = BigInt(String(reported));
  } catch {
    return undefined;
  }
  if (value < 0n || value > bounds.ceiling) return undefined;

  const charged = parseChargedAmount(extra);
  if (charged !== undefined) {
    return value === bounds.preCumulative + charged ? value : undefined;
  }
  return value === bounds.ceiling ? value : undefined;
}

/**
 * The receipt's `extra.chargedAmount`, when it is a usable amount. An
 * unusable figure cannot vouch for a metered settlement, so the receipt
 * falls back to the stricter unmetered equality.
 */
function parseChargedAmount(
  extra: Record<string, unknown> | undefined,
): bigint | undefined {
  const raw = extra?.chargedAmount;
  if (typeof raw !== 'string' && typeof raw !== 'number') return undefined;
  try {
    const value = BigInt(String(raw));
    return value >= 0n ? value : undefined;
  } catch {
    return undefined;
  }
}

function parseStoredCumulative(
  state: X402ChannelState | undefined,
): bigint | undefined {
  if (state?.chargedCumulativeAmount === undefined) return undefined;
  try {
    const value = BigInt(state.chargedCumulativeAmount);
    return value >= 0n ? value : undefined;
  } catch {
    return undefined;
  }
}

/**
 * What a signed `batch-settlement` payload proves on its own: the channel,
 * the cumulative ceiling its voucher authorized, and the deposit it funds
 * (when it carries one). Read it off a payload with
 * `getX402BatchSettlementBinding`.
 *
 * Reconciliation needs the full `X402BatchSettlementBinding`, which adds the
 * trusted pre-attempt snapshot — information the payload cannot carry.
 */
export interface X402BatchSettlementPayloadBinding {
  /** Channel the voucher was signed against. */
  channelId: string;
  /** Cumulative ceiling the voucher authorized. */
  maxClaimableAmount: string;
  /**
   * Amount this payload funds the channel with, when it carries a deposit.
   * Absent for a voucher-only payload, which funds nothing.
   *
   * Together with `preAttemptState.balance` it establishes the floor the
   * merchant's reported `balance` must clear — see `foldChannelState`.
   */
  depositAmount?: string;
}

/**
 * Everything `reconcileX402BatchSettlement` needs to commit one attempt:
 * what the payload authorized plus the trusted channel snapshot taken when
 * it was signed. `signX402Payment` assembles it as `SignedX402Payment.batch`.
 */
export interface X402BatchSettlementBinding
  extends X402BatchSettlementPayloadBinding {
  /**
   * Channel state as stored immediately before this attempt signed —
   * explicitly `undefined` when no record existed (a fresh channel).
   *
   * This is the fold's only trusted balance source. Basing the write on the
   * snapshot rather than on whatever storage holds at reconcile time is what
   * makes retries exact: after a torn write the stored record is precisely
   * the thing that cannot be trusted. The key is required (not optional) so
   * a caller cannot forget the snapshot and silently degrade the floor to
   * the deposit alone.
   */
  preAttemptState: X402ChannelState | undefined;
}

/**
 * Read the payload-provable half of a `batch-settlement` binding out of a
 * signed payload. Returns `undefined` for a payload of any other scheme.
 *
 * Both payload shapes the scheme produces — the opening `deposit` and the
 * subsequent voucher-only one — carry it under `payload.voucher`. Callers
 * resuming a persisted attempt combine this with the pre-attempt snapshot
 * they captured at signing time to rebuild the full
 * `X402BatchSettlementBinding`; live callers get that assembled on
 * `SignedX402Payment.batch` already.
 */
export function getX402BatchSettlementBinding(
  payload: X402PaymentPayload,
): X402BatchSettlementPayloadBinding | undefined {
  const inner = (payload as { payload?: unknown }).payload;
  if (typeof inner !== 'object' || inner === null) return undefined;
  const voucher = (inner as { voucher?: unknown }).voucher;
  if (typeof voucher !== 'object' || voucher === null) return undefined;
  const { channelId, maxClaimableAmount } = voucher as {
    channelId?: unknown;
    maxClaimableAmount?: unknown;
  };
  if (!isCanonicalChannelId(channelId)) return undefined;
  if (typeof maxClaimableAmount !== 'string') return undefined;

  // Present only on the opening / top-up shape; a voucher-only payload funds
  // nothing and leaves the balance floor at the pre-attempt snapshot.
  const deposit = (inner as { deposit?: unknown }).deposit;
  const depositAmount =
    typeof deposit === 'object' && deposit !== null
      ? (deposit as { amount?: unknown }).amount
      : undefined;

  return {
    channelId,
    maxClaimableAmount,
    ...(typeof depositAmount === 'string' ? { depositAmount } : {}),
  };
}
