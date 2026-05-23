import type { PaymentResult } from './types.js';

/**
 * The failure message to render on a rejected payment: the SATIM response-code
 * description, falling back to the action-code description. This is the order
 * SATIM **certification requires** on the return page — never show a raw code or
 * a generic "server error". Returns `null` when the gateway gave no reason.
 *
 * @example
 *   const msg = failureReason(result.satim); // → "Solde insuffisant"
 */
export function failureReason(satim: PaymentResult['satim']): string | null {
  return satim.respCodeDesc ?? satim.actionCodeDescription ?? null;
}
