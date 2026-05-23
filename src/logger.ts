/**
 * Minimal structured-logging interface. Structural by design — `console`, pino,
 * winston and bunyan all satisfy it, so tasdid takes no logging dependency.
 *
 * Implementations must never throw and never receive a PAN or credentials:
 * tasdid only ever passes opaque ids and statuses in `fields`.
 */
export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** The default sink — discards everything. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};
