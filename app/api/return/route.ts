// GET /api/m/square-payment-for-shop/return
// The redirect_url Square sends the shopper back to after they pay on the
// hosted checkout page. Confirms server-side where possible, then hands off to
// the shop confirmation page. The webhook remains the source of truth for
// settlement.
//
// This method does not create its order until the card has been authorised (see
// the shop's lib/checkout-draft), so there may be no order here at all - and
// where the shopper closed the hosted page without paying, there should not be.
// That case goes back to the checkout with the basket still in it, rather than
// to a confirmation page for something nobody paid for.
import { NextRequest, NextResponse } from 'next/server'
import { getSiteUrl } from '@/lib/config/env'
import { signOrderReceiptToken } from '@/modules/shop/lib/order-receipt-token'
import { getOrderById } from '@/modules/shop/lib/db/orders'
import * as sq from '@/modules/square-payment-for-shop/lib/square'
import { getSqpPaymentByOrderId } from '@/modules/square-payment-for-shop/lib/db'
import { settleFromPayment } from '@/modules/square-payment-for-shop/lib/settle'

export async function GET(request: NextRequest) {
  const siteUrl = getSiteUrl()
  const checkoutUrl = `${siteUrl}/shop/checkout`

  const orderId = request.nextUrl.searchParams.get('order')
  if (!orderId) return NextResponse.redirect(checkoutUrl)

  const row = await getSqpPaymentByOrderId(orderId)
  if (!row?.squareOrderId) return NextResponse.redirect(checkoutUrl)

  try {
    const squareOrder = await sq.getOrder(row.squareOrderId)
    // No payment on the Square order means the shopper never completed the
    // hosted page. Nothing is created and they go back to the checkout.
    if (squareOrder.paymentId) {
      // settleFromPayment does the rest: it checks the money is this order's,
      // creates the order if it has not been created yet, and marks it PAID or
      // awaiting depending on whether the card has been captured.
      await settleFromPayment(row, await sq.getPayment(squareOrder.paymentId))
    }
  } catch (err) {
    // If Square is unreachable on return, leave things as they are; the webhook
    // will settle it.
    console.error('[square-payment] return confirmation failed', err)
  }

  // Read after settling, never before: on this method the order is very often
  // brought into being by the lines above.
  const order = await getOrderById(orderId)
  if (!order) return NextResponse.redirect(checkoutUrl)

  // The signed receipt token, never the customer's email address. A redirect
  // URL lands in the site's access logs, the shopper's browser history and the
  // Referer header sent to every third party the confirmation page loads - and
  // an email address has no business in any of them. See shop's
  // lib/order-receipt-token, which the confirmation page verifies against.
  const confirmationUrl =
    `${siteUrl}/shop/checkout/confirmation` +
    `?orderNumber=${encodeURIComponent(order.orderNumber)}&t=${encodeURIComponent(signOrderReceiptToken(order.orderNumber))}`
  return NextResponse.redirect(confirmationUrl)
}
