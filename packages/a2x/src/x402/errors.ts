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
 * Thrown when the merchant claims an `x402Version` the SDK can't speak.
 * x402-v1 §6 / §9: only `x402Version: 1` is defined. The wire `code`
 * matches the spec's `invalid_x402_version` token verbatim — a2a-x402
 * v0.2 §9.1 doesn't redefine this code (it only enumerates seven
 * UPPERCASE codes none of which apply here), so x402-v1's lowercase
 * spelling is the authoritative wire form.
 */
export class X402InvalidVersionError extends X402Error {
  readonly version: number;
  readonly code = 'invalid_x402_version';

  constructor(version: number) {
    super(
      `Unsupported x402Version ${version}; this SDK only speaks x402Version 1.`,
    );
    this.name = 'X402InvalidVersionError';
    this.version = version;
  }
}
