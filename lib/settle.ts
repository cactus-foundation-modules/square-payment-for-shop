// Shared confirmation logic used by both the redirect-return route and the
// webhook: given our payment row and the current Square payment, move the
// shop order to its final state exactly once.
import { getOrderById, markOrderAwaitingConfirmation, markOrderPaid, markOrderPaymentFailed, setOrderPaymentReference } from '@/modules/shop/lib/db/orders'
import { getCheckoutDraft, materialiseDraftOrder } from '@/modules/shop/lib/checkout-draft'
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

  if (isPaymentFailed(payment.status)) {
    // FAILED and CANCELED are both pre-capture outcomes on a hosted checkout
    // payment, so a plain FAILED is the right shop-side state. Card disputes are
    // separate Square objects (not payment statuses) and are handled in the
    // Square dashboard, not here.
    //
    // No order at all means the shopper never got far enough to have one, which
    // is the entire point of drafting them: a card that was declined leaves
    // nothing behind, so there is nothing here to mark as failed.
    if (!(await getOrderById(row.orderId))) return
    await markOrderPaymentFailed(row.orderId, 'FAILED')
    return
  }

  // Never fulfil - or create - on status alone. See paymentMatchesOrder. The
  // figures are checked against the order where there is one and against the
  // draft where there is not yet, because the check has to happen BEFORE the
  // order is brought into being.
  const target = (await getOrderById(row.orderId)) ?? (await getCheckoutDraft(row.orderId))
  if (!target) {
    console.error(`[square-payment] payment ${payment.id} settled against a missing order ${row.orderId}`)
    return
  }
  if (!paymentMatchesOrder(payment, target)) {
    // Left unfulfilled and loudly logged rather than marked PAID (goods shipped
    // against money never charged) or marked FAILED (the money may well HAVE
    // been taken; telling the shopper otherwise is its own kind of wrong). A
    // human needs to look at it either way.
    console.error(
      `[square-payment] payment ${payment.id} does not match order ${target.orderNumber}: ` +
      `collected ${payment.amount} ${payment.currency}, order expects ${toMinorUnits(Number(target.total))} ${target.currency}`,
    )
    return
  }

  // A payment exists on the Square order only once the shopper has been through
  // the hosted checkout page, so by here the card has at least been authorised.
  // That is the moment the order earns its existence. Idempotent, so the
  // redirect back and the webhook racing each other create exactly one.
  const order = await materialiseDraftOrder(row.orderId)
  if (!order) {
    console.error(`[square-payment] payment ${payment.id} could not be given an order (${row.orderId})`)
    return
  }

  if (!isPaymentCollected(payment.status)) {
    // APPROVED rather than COMPLETED: authorised, not captured. The shopper sees
    // the "awaiting" state and the webhook flips it to PAID on capture. Never
    // downgrade an order that is already PAID.
    const fresh = await getOrderById(order.id)
    if (fresh && fresh.paymentStatus !== 'PAID') await markOrderAwaitingConfirmation(order.id)
    return
  }

  await setOrderPaymentReference(order.id, payment.id)
  // markOrderPaid is idempotent (no-op once already PAID), so a replayed
  // webhook can't fulfil the order twice.
  const justPaid = await markOrderPaid(order.id, payment.id)
  if (justPaid) await fulfillPaidOrder(order.id)
}
