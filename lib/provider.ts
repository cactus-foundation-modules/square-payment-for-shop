// The Square payment provider, registered into the shop checkout via the
// `shop.payment-providers` extension point (see the manifest). Card entry
// happens on Square's hosted checkout page, so no card data touches the site.
import { getSiteUrl } from '@/lib/config/env'
import type {
  ShpOrderDraft, ShpPaymentIntent, ShpPaymentProvider, ShpPaymentResult, ShpRefundRequest, ShpRefundResult,
} from '@/modules/shop/lib/payments/provider'
import { isSquareConfigured } from '@/modules/square-payment-for-shop/lib/env'
import { getSquareSettings } from '@/modules/square-payment-for-shop/lib/settings'
import * as sq from '@/modules/square-payment-for-shop/lib/square'
import { createSqpPayment, getSqpPaymentByOrderId, updateSqpPayment } from '@/modules/square-payment-for-shop/lib/db'
import { squareLogo } from '@/modules/square-payment-for-shop/lib/logo'

const METHOD_ID = 'SQUARE'
const RETURN_PATH = '/api/m/square-payment-for-shop/return'

function toMinorUnits(amount: number): number {
  return Math.round(amount * 100)
}

// Offered at checkout only when the credentials are set AND the admin has turned
// the method on in its settings tab. Both come off one settings read, so the
// credentials checked are always the ones for the environment the shop is
// actually in.
async function isAvailable(): Promise<boolean> {
  const settings = await getSquareSettings()
  return settings.enabled && isSquareConfigured(settings.environment)
}

// What the method is called at checkout and in the admin. The shop owner names
// it on the settings tab; the fixed `label` below is only what a shop that has
// left the box empty falls back to.
async function getLabel(): Promise<string> {
  const settings = await getSquareSettings()
  return settings.paymentDescription
}

async function createIntent(order: ShpOrderDraft): Promise<ShpPaymentIntent> {
  const settings = await getSquareSettings()
  const prefix = settings.paymentDescription.trim()
  const description = prefix ? `${prefix} (${order.orderNumber})` : `Order ${order.orderNumber}`

  const siteUrl = getSiteUrl()
  const link = await sq.createPaymentLink({
    amount: toMinorUnits(order.amount),
    currency: order.currency.toUpperCase(),
    description,
    referenceId: order.orderNumber,
    redirectUrl: `${siteUrl}${RETURN_PATH}?order=${encodeURIComponent(order.orderId)}`,
    idempotencyKey: `sqp-pl-${order.orderId}`,
  })

  await createSqpPayment({
    orderId: order.orderId,
    orderNumber: order.orderNumber,
    paymentLinkId: link.id,
    squareOrderId: link.squareOrderId,
    amount: order.amount,
    currency: order.currency,
  })

  return { approvalUrl: link.url, providerOrderId: link.squareOrderId }
}

// Best-effort confirmation for the on-page confirm route. The redirect-return
// route and webhook are the real confirmation path; this simply reports whether
// the payment has settled yet, re-validating amount/currency and never trusting
// the client payload.
async function confirmPayment(order: ShpOrderDraft): Promise<ShpPaymentResult> {
  const row = await getSqpPaymentByOrderId(order.orderId)
  if (!row?.squareOrderId) return { success: false, error: 'No Square payment was found for this order.' }

  const squareOrder = await sq.getOrder(row.squareOrderId)
  if (!squareOrder.paymentId) {
    // No payment on the Square order means the shopper has not completed the
    // hosted checkout page yet. Reporting success here would park the order as
    // "awaiting confirmation" without a penny having been charged.
    return { success: false, error: 'This payment has not been completed with Square yet.' }
  }

  const payment = await sq.getPayment(squareOrder.paymentId)
  if (payment.amount !== toMinorUnits(order.amount)) return { success: false, error: 'Payment amount does not match this order.' }
  if (payment.currency.toUpperCase() !== order.currency.toUpperCase()) return { success: false, error: 'Payment currency does not match this order.' }

  await updateSqpPayment(row.id, { paymentId: payment.id, status: payment.status })
  if (sq.isPaymentFailed(payment.status)) return { success: false, error: 'The card payment did not go through.' }
  return { success: true, pending: !sq.isPaymentCollected(payment.status), providerReference: payment.id }
}

async function refundOrder(refund: ShpRefundRequest): Promise<ShpRefundResult> {
  try {
    if (!refund.providerReference) return { success: false, error: 'No Square payment reference to refund against.' }
    const payment = await sq.getPayment(refund.providerReference)

    // Re-validate against what was actually captured before issuing (never trust
    // the request alone): a currency mismatch or an over-refund is rejected here
    // rather than handed to Square.
    if (refund.currency.toUpperCase() !== payment.currency.toUpperCase()) {
      return { success: false, error: 'Refund currency does not match the original payment.' }
    }
    const amountMinor = toMinorUnits(refund.amount)
    if (amountMinor <= 0) return { success: false, error: 'Refund amount must be greater than zero.' }
    const refundableMinor = payment.amount - payment.amountRefunded
    if (amountMinor > refundableMinor) {
      return { success: false, error: 'Refund amount exceeds the amount still refundable on this payment.' }
    }

    // The idempotency key (a deterministic key supplied by the shop refund
    // route) stops a retried/double refund executing twice on Square.
    const result = await sq.createRefund({
      paymentId: refund.providerReference,
      amount: amountMinor,
      currency: payment.currency,
      idempotencyKey: refund.idempotencyKey ?? `sqp-refund-${refund.providerReference}-${amountMinor}`,
    })
    return { success: true, providerRefundId: result.id }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : 'Square refund failed' }
  }
}

export const squarePaymentProvider: ShpPaymentProvider = {
  id: METHOD_ID,
  label: 'Card payment (Square)',
  description: 'Credit and debit card payments are securely handled by our payment partner Square.',
  logo: squareLogo,
  getLabel,
  confirmMode: 'auto',
  isAvailable,
  createIntent,
  confirmPayment,
  refundOrder,
}
