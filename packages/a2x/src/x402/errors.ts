/**
 * x402-specific error types. Thrown client-side by `A2XClient` (when
 * its `x402` option is configured) and the `signX402Payment` primitive
 * when the server or the x402 flow itself produces something unactionable.
 *
 * Server-side the SDK doesn't throw — it emits a `payment-failed` task
 * status with an error code under `x402.payment.error`.
 */

import type { X402ErrorCode } from './constants.js';

export class X402Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'X402Error';
  }
}

export class X402PaymentRequiredError extends X402Error {
  constructor(message: string = 'Payment is required but no signer is configured') {
    super(message);
    this.name = 'X402PaymentRequiredError';
  }
}

export class X402PaymentFailedError extends X402Error {
  readonly code: X402ErrorCode | string;
  readonly transaction?: string;
  readonly network?: string;

  constructor(
    message: string,
    code: X402ErrorCode | string,
    details?: { transaction?: string; network?: string },
  ) {
    super(message);
    this.name = 'X402PaymentFailedError';
    this.code = code;
    this.transaction = details?.transaction;
    this.network = details?.network;
  }
}

export class X402NoSupportedRequirementError extends X402Error {
  constructor(message: string = 'No payment requirement in the server response matches the configured signer') {
    super(message);
    this.name = 'X402NoSupportedRequirementError';
  }
}

/**
 * Thrown when an optional x402 peer dependency isn't installed.
 *
 * `@x402/core` / `@x402/evm` are optional peers loaded lazily on the first
 * sign / verify / settle, so a missing peer would otherwise surface as a raw
 * `ERR_MODULE_NOT_FOUND` in the middle of a payment round-trip — long after
 * install, typecheck, and startup all passed. This names the packages to
 * install instead, and calls out the peer rename for anyone upgrading.
 */
export class X402PeerMissingError extends X402Error {
  /** Bare package name that failed to resolve (e.g. `@x402/core`). */
  readonly packageName: string;
  /** Full specifier the SDK tried to import (e.g. `@x402/core/http`). */
  readonly specifier: string;

  constructor(specifier: string, packageName: string, options?: { cause?: unknown }) {
    super(
      `Cannot load "${packageName}", required for x402 payments. ` +
        'Install the optional peer dependencies:\n' +
        '  npm install @x402/core @x402/evm viem\n' +
        'Upgrading from @a2x/sdk 0.15 or earlier? The signing and facilitator ' +
        'runtime moved from `x402` to `@x402/core` + `@x402/evm`.',
    );
    this.name = 'X402PeerMissingError';
    this.packageName = packageName;
    this.specifier = specifier;
    if (options && 'cause' in options) {
      // Preserve the original resolution error for debugging without
      // depending on the ES2022 `cause` constructor option.
      (this as { cause?: unknown }).cause = options.cause;
    }
  }
}

/**
 * Thrown when the merchant claims an `x402Version` the SDK can't speak.
 * a2x supports x402Version 1 and 2. The wire `code` matches the spec's
 * `invalid_x402_version` token verbatim — a2a-x402 v0.2 §9.1 doesn't
 * redefine this code (it only enumerates seven UPPERCASE codes none of
 * which apply here), so x402-v1's lowercase spelling is the authoritative
 * wire form.
 */
export class X402InvalidVersionError extends X402Error {
  readonly version: number;
  readonly code = 'invalid_x402_version';

  constructor(version: number) {
    super(
      `Unsupported x402Version ${version}; this SDK speaks x402Version 1 and 2.`,
    );
    this.name = 'X402InvalidVersionError';
    this.version = version;
  }
}
