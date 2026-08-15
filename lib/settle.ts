// Shared confirmation logic used by both the redirect-return route and the
// webhook: given our payment row and the current Square payment, move the
// shop order to its final state exactly once.
import { getOrderById, markOrderPaid, markOrderPaymentFailed, setOrderPaymentReference } from '@/modules/shop/lib/db/orders'
import { fulfillPaidOrder } from '@/modules/shop/lib/order-fulfillment'
import { isPaymentCollected, isPaymentFailed, type SqPayment } from '@/modules/square-payment-for-shop/lib/square'
import { updateSqpPayment, type SqpPayment } from '@/modules/square-payment-for-shop/lib/db'

function toMinorUnits(amount: number): number {
  return Math.round(amount * 100)
}

/** Whether a settled payment is genuinely for this order: same money, same
 *  currency. Exported for the tests.
 *
 *  The same gap the GoCardless module had: `confirmPayment` compared the figures
 *  and refused a mismatch, while this function - which the webhook and the
 *  redirect-return route both go through, and which is how most payments
 *  actually settle - marked the order PAID on the payment's status alone. */
export function paymentMatchesOrder(
  payment: Pick<SqPayment, 'amount' | 'currency'>,
  order: { total: unknown; currency: string },
): boolean {
  const expected = toMinorUnits(Number(order.total))
  if (!Number.isFinite(expected)) return false
  if (payment.amount !== expected) return false
  return payment.currency.toUpperCase() === order.currency.toUpperCase()
}

export async function settleFromPayment(row: SqpPayment, payment: SqPayment): Promise<void> {
  await updateSqpPayment(row.id, { paymentId: payment.id, status: payment.status })

  if (isPaymentCollected(payment.status)) {
    // Never fulfil on status alone - see paymentMatchesOrder. A collected
    // payment that does not match is left unfulfilled and loudly logged rather
    // than marked PAID (goods shipped against money never charged) or marked
    // FAILED (the money HAS been taken; telling the shopper otherwise is its own
    // kind of wrong). A human needs to look at it either way.
    const order = await getOrderById(row.orderId)
    if (!order) {
      console.error(`[square-payment] payment ${payment.id} settled against a missing order ${row.orderId}`)
      return
    }
    if (!paymentMatchesOrder(payment, order)) {
      console.error(
        `[square-payment] payment ${payment.id} does not match order ${order.orderNumber}: ` +
        `collected ${payment.amount} ${payment.currency}, order expects ${toMinorUnits(Number(order.total))} ${order.currency}`,
      )
      return
    }
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
