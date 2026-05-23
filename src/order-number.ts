import { randomBytes } from 'node:crypto';

/**
 * Generate a SATIM-valid order number: 10 uppercase hex chars. SATIM caps the
 * order number at 10 characters, so a longer one makes `register` fail — use
 * this (or your own ≤ 10-char unique id) as `StartOrder.orderNumber`.
 */
export function generateOrderNumber(): string {
  return randomBytes(5).toString('hex').toUpperCase();
}
