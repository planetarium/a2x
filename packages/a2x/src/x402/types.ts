/**
 * a2a-x402 type definitions — dual-version (x402 V1 and V2).
 *
 * a2x speaks two versions of the x402 protocol on the wire:
 *
 *  - **V1** (`x402Version: 1`) — bare network names (`"base-sepolia"`),
 *    `maxAmountRequired`, and `resource`/`description`/`mimeType` inline in
 *    each requirement. This is the version a2a-x402 v0.2 pinned to.
 *  - **V2** (`x402Version: 2`) — CAIP-2 network ids (`"eip155:84532"`),
 *    `amount`, a hoisted top-level `resource` object, and a `PaymentPayload`
 *    that echoes the chosen requirement under `accepted`. This is the
 *    version the x402 Foundation A2A transport defines.
 *
 * The wire shapes are defined locally (not imported from a signing package)
 * so this type surface stays stable regardless of which optional peer
 * (`@x402/core` / `@x402/evm`) is installed, and so the two versions can
 * be modelled as an explicit discriminated union keyed on `x402Version`.
 *
 * The five `x402.payment.*` metadata keys, the payment status lifecycle, and
 * the EIP-3009 signing typed-data are identical across both protocol versions —
 * only the requirements/payload envelopes differ.
 */

/**
 * Blockchain network identifier. V1 uses bare names (`"base-sepolia"`),
 * V2 uses CAIP-2 (`"eip155:84532"`). Typed permissively so callers may
 * supply either; the wire codecs normalize to the version being emitted.
 */
export type X402Network =
  | 'base'
  | 'base-sepolia'
  | 'avalanche'
  | 'avalanche-fuji'
  | 'polygon'
  | 'polygon-amoy'
  | `eip155:${string}`
  // Preserve autocomplete for the well-known ids above while accepting any
  // other network string (other bare names, other CAIP-2 namespaces).
  | (string & {});

/** EVM EIP-3009 authorization — identical across V1 and V2. */
export interface X402EvmAuthorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/** Inner signed payload for the `exact` EVM scheme — same shape in both protocol versions. */
export interface X402ExactEvmPayload {
  signature: string;
  authorization: X402EvmAuthorization;
}

// ─── V1 wire shapes (x402Version: 1) ───

/** A single V1 payment option. */
export interface X402PaymentRequirementsV1 {
  scheme: string;
  /** Bare network name, e.g. `"base-sepolia"`. */
  network: string;
  /** Maximum payable amount in the asset's smallest unit. */
  maxAmountRequired: string;
  /** URL of the protected resource. */
  resource: string;
  /** Human-readable description shown to the payer. */
  description: string;
  /** MIME type of the expected response. */
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  extra?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

/** V1 `payment-required` payload published under `x402.payment.required`. */
export interface X402PaymentRequiredResponseV1 {
  x402Version: 1;
  accepts: X402PaymentRequirementsV1[];
  error?: string;
}

/** V1 signed `PaymentPayload` submitted under `x402.payment.payload`. */
export interface X402PaymentPayloadV1 {
  x402Version: 1;
  scheme: string;
  /** Bare network name. */
  network: string;
  payload: X402ExactEvmPayload | Record<string, unknown>;
}

// ─── V2 wire shapes (x402Version: 2) ───

/** Top-level resource descriptor hoisted out of the requirements in V2. */
export interface X402ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

/** A single V2 payment option. */
export interface X402PaymentRequirementsV2 {
  scheme: string;
  /** CAIP-2 network id, e.g. `"eip155:84532"`. */
  network: string;
  asset: string;
  /** Maximum payable amount in the asset's smallest unit. */
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
  extra?: Record<string, unknown>;
}

/** V2 `payment-required` payload published under `x402.payment.required`. */
export interface X402PaymentRequiredResponseV2 {
  x402Version: 2;
  resource: X402ResourceInfo;
  accepts: X402PaymentRequirementsV2[];
  error?: string;
  extensions?: Record<string, unknown>;
}

/** V2 signed `PaymentPayload` — echoes the chosen requirement under `accepted`. */
export interface X402PaymentPayloadV2 {
  x402Version: 2;
  resource?: X402ResourceInfo;
  accepted: X402PaymentRequirementsV2;
  payload: X402ExactEvmPayload | Record<string, unknown>;
  extensions?: Record<string, unknown>;
}

// ─── Version unions ───

/**
 * A payment option in either version. Discriminate by presence of
 * `maxAmountRequired` (V1) vs `amount` (V2), or read fields through the
 * version-agnostic accessors in `versions.ts`.
 */
export type X402PaymentRequirements =
  | X402PaymentRequirementsV1
  | X402PaymentRequirementsV2;

/** The `payment-required` payload in either version. Discriminate on `x402Version`. */
export type X402PaymentRequiredResponse =
  | X402PaymentRequiredResponseV1
  | X402PaymentRequiredResponseV2;

/** The signed `PaymentPayload` in either version. Discriminate on `x402Version`. */
export type X402PaymentPayload = X402PaymentPayloadV1 | X402PaymentPayloadV2;

// ─── Facilitator responses ───

/**
 * Facilitator `verify` result. `isValid`/`invalidReason` are shared across
 * both protocol versions; the extra fields are passed through untouched.
 */
export interface X402VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  invalidMessage?: string;
  payer?: string;
  [key: string]: unknown;
}

/**
 * Raw facilitator `settle` result. a2x trims this into the wire receipt
 * (`X402SettleResponse`) attached to the task. `success`/`transaction`/
 * `network`/`payer`/`errorReason` are shared; V2 adds optional `amount`.
 */
export interface X402FacilitatorSettleResponse {
  success: boolean;
  transaction?: string;
  network?: string;
  payer?: string;
  errorReason?: string;
  errorMessage?: string;
  amount?: string;
  [key: string]: unknown;
}

/**
 * Settlement receipt attached to `message.metadata['x402.payment.receipts']`
 * on the task's final message. Version-invariant.
 */
export interface X402SettleResponse {
  success: boolean;
  /** Transaction hash on success, empty string on failure. */
  transaction: string;
  /** Network the settlement occurred on (bare name for V1, CAIP-2 for V2). */
  network: string;
  /**
   * Address of the payer's wallet. **Optional** — x402 V2 (and the foundation
   * A2A transport's failure examples) mark `payer` optional, and V2 receipts
   * from third-party servers may omit it. The SDK propagates whatever the
   * facilitator returns; for EVM "exact" payloads it fills it from
   * `authorization.from` when the facilitator omits it, and leaves it absent
   * otherwise (never a placeholder like `'unknown'`).
   */
  payer?: string;
  /** Short error code (e.g. `VERIFY_FAILED`) when `success` is false. */
  errorReason?: string;
}

/**
 * Minimal shape the SDK needs from a payment facilitator.
 *
 * Matches the `verify`/`settle` methods of `@x402/core`'s
 * `HTTPFacilitatorClient` (and x402 v1's `useFacilitator()`), abstracted so
 * callers can plug in a different backend (mock facilitator in tests, a
 * custom routing proxy, a different vendor). The facilitator is handed the
 * raw wire payload and the requirement of whichever version the task
 * negotiated; both `HTTPFacilitatorClient` and the reference facilitators
 * dispatch on `x402Version` internally.
 */
export interface X402Facilitator {
  verify(
    payload: X402PaymentPayload,
    requirements: X402PaymentRequirements,
  ): Promise<X402VerifyResponse>;
  settle(
    payload: X402PaymentPayload,
    requirements: X402PaymentRequirements,
  ): Promise<X402FacilitatorSettleResponse>;
}

/**
 * What the caller gives the SDK when configuring x402 support. A single
 * `network`/`asset`/`amount`/`payTo` triple with sensible defaults for
 * everything else the spec demands (scheme, mime type, timeout, extra).
 *
 * `network` may be a bare name (`"base-sepolia"`) or CAIP-2
 * (`"eip155:84532"`); the wire codec normalizes it to the version being
 * emitted, so agents configure it once and it works under both V1 and V2.
 *
 * `resource` and `description` are required: strict facilitators reject
 * non-URL `resource`, and wallet UIs surface `description` as the consent
 * prompt for the user.
 */
export interface X402Accept {
  /** Blockchain network id — bare name or CAIP-2 (e.g. `"base-sepolia"` / `"eip155:84532"`). */
  network: X402Network;
  /** Amount in the asset's smallest unit (USDC: 6 decimals → `"1000000"` = 1 USDC). */
  amount: string;
  /** Token contract address (for ERC-20) or asset identifier. */
  asset: string;
  /** Wallet address that should receive the payment. */
  payTo: string;
  /**
   * Human-readable description of the resource — shown to the paying
   * client, often as a wallet consent prompt.
   */
  description: string;
  /**
   * URL of the protected resource. Strict facilitators reject non-URL
   * values. Use the public URL the client is paying to access (e.g.
   * `https://api.example.com/premium-data`).
   */
  resource: string;
  /** MIME type of the expected response. Defaults to `"application/json"`. */
  mimeType?: string;
  /** Payment expiry window in seconds. Defaults to 300. */
  maxTimeoutSeconds?: number;
  /** Scheme-specific extra fields (EIP-712 name/version for USDC etc.). */
  extra?: Record<string, unknown>;
  /** Payment scheme. Only `"exact"` is defined by the x402 spec. */
  scheme?: 'exact';
}
