// GET /api/m/square-payment-for-shop/return
// The redirect_url Square sends the shopper back to after they pay on the
// hosted checkout page. Confirms server-side where possible, then hands off to
// the shop confirmation page. The webhook remains the source of truth for
// settlement.
import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { getOrderById, markOrderAwaitingConfirmation } from '@/modules/shop/lib/db/orders'
import * as sq from '@/modules/square-payment-for-shop/lib/square'
import { getSqpPaymentByOrderId } from '@/modules/square-payment-for-shop/lib/db'
import { settleFromPayment } from '@/modules/square-payment-for-shop/lib/settle'

export async function GET(request: NextRequest) {
  const siteUrl = getSiteUrl()
  const checkoutUrl = `${siteUrl}/shop/checkout`

  const orderId = request.nextUrl.searchParams.get('order')
  if (!orderId) return NextResponse.redirect(checkoutUrl)

  const order = await getOrderById(orderId)
  const row = await getSqpPaymentByOrderId(orderId)
  if (!order || !row?.squareOrderId) return NextResponse.redirect(checkoutUrl)

  try {
    const squareOrder = await sq.getOrder(row.squareOrderId)
    if (squareOrder.paymentId) {
      const payment = await sq.getPayment(squareOrder.paymentId)
      await settleFromPayment(row, payment)
      // Paid but not yet captured: show the shopper the "awaiting" state
      // (don't downgrade an order the webhook already marked PAID).
      if (!sq.isPaymentCollected(payment.status) && !sq.isPaymentFailed(payment.status)) {
        const fresh = await getOrderById(orderId)
        if (fresh && fresh.paymentStatus !== 'PAID') await markOrderAwaitingConfirmation(orderId)
      }
    } else {
      const fresh = await getOrderById(orderId)
      if (fresh && fresh.paymentStatus !== 'PAID') await markOrderAwaitingConfirmation(orderId)
    }
  } catch (err) {
    // If Square is unreachable on return, leave the order as-is; the webhook
    // will settle it.
    console.error('[square-payment] return confirmation failed', err)
  }

  const confirmationUrl =
    `${siteUrl}/shop/checkout/confirmation` +
    `?orderNumber=${encodeURIComponent(order.orderNumber)}&email=${encodeURIComponent(order.customerEmail)}`
  return NextResponse.redirect(confirmationUrl)
}
