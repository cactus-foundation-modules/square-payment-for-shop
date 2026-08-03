// Shared confirmation logic used by both the redirect-return route and the
// webhook: given our payment row and the current Square payment, move the
// shop order to its final state exactly once.
import { markOrderPaid, markOrderPaymentFailed, setOrderPaymentReference } from '@/modules/shop/lib/db/orders'
import { fulfillPaidOrder } from '@/modules/shop/lib/order-fulfillment'
import { isPaymentCollected, isPaymentFailed, type SqPayment } from '@/modules/square-payment-for-shop/lib/square'
import { updateSqpPayment, type SqpPayment } from '@/modules/square-payment-for-shop/lib/db'

export async function settleFromPayment(row: SqpPayment, payment: SqPayment): Promise<void> {
  await updateSqpPayment(row.id, { paymentId: payment.id, status: payment.status })

  if (isPaymentCollected(payment.status)) {
    await setOrderPaymentReference(row.orderId, payment.id)
    // markOrderPaid is idempotent (no-op once already PAID), so a replayed
    // webhook can't fulfil the order twice.
    const justPaid = await markOrderPaid(row.orderId, payment.id)
    if (justPaid) await fulfillPaidOrder(row.orderId)
  } else if (isPaymentFailed(payment.status)) {
    // FAILED and CANCELED are both pre-capture outcomes on a hosted checkout
    // payment, so a plain FAILED is the right shop-side state. Card disputes are
    // separate Square objects (not payment statuses) and are handled in the
    // Square dashboard, not here.
    await markOrderPaymentFailed(row.orderId, 'FAILED')
  }
}
