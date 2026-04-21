/**
 * x402-specific error types. Thrown client-side by helpers like
 * `signX402Payment` and `X402Client` when the server or the x402 flow
 * itself produces something unactionable.
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
