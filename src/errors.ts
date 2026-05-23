export type TasdidErrorCode =
  | 'REGISTER_FAILED'
  | 'NOT_FOUND'
  | 'NOT_REFUNDABLE'
  | 'REFUND_EXCEEDS_DEPOSIT'
  | 'REFUND_FAILED'
  | 'INVALID_TRANSITION'
  | 'INVALID_INPUT';

/** Error thrown by tasdid for lifecycle, gateway and validation failures. */
export class TasdidError extends Error {
  readonly code: TasdidErrorCode;
  /** The underlying SATIM gateway error code, when the failure came from the gateway. */
  readonly satimErrorCode?: number;

  constructor(message: string, code: TasdidErrorCode, satimErrorCode?: number) {
    super(message);
    this.name = 'TasdidError';
    this.code = code;
    if (satimErrorCode !== undefined) this.satimErrorCode = satimErrorCode;
  }
}
