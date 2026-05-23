import type { PaymentStatus } from './types.js';

/**
 * Map a SATIM `OrderStatus` code to the tasdid lifecycle status a *pending*
 * payment should move to. Non-final codes stay `pending` (keep reconciling).
 *
 * SATIM codes: 2 deposited · 11 debited · 6 declined · 3 reversed · -1 decline
 * placeholder · 4 refunded · 0 registered-not-paid · 1 approved/preauth.
 */
export function mapSatimStatus(orderStatus: number | null): PaymentStatus {
  switch (orderStatus) {
    case 2:
    case 11:
      return 'paid';
    case 6:
    case 3:
    case -1:
      return 'failed';
    case 4:
      return 'refunded';
    default:
      // 0 (registered, not paid), 1 (approved/on-hold), or anything unknown → keep waiting.
      return 'pending';
  }
}
