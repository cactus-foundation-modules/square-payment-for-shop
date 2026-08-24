// The Square payment provider, registered into the shop checkout via the
// `shop.payment-providers` extension point (see the manifest).
//
// Two ways of taking the card, chosen by the shop owner on the settings tab:
//
//  'hosted'  - Square's own checkout page. The shopper is sent to squareup.com
//              and redirected back to /api/return.
//  'on-page' - Square's Web Payments SDK draws its card fields on this site's
//              own checkout, hands back a one-time token, and confirmPayment
//              below charges it. See components/public/SquareCardFields.tsx.
//
// Card data touches this site in neither: the hosted page is Square's, and the
// on-page fields are Square's own frames inside our page. What differs is the
// trip - and how many shoppers come back from it.
import { createHash } from 'crypto'
import { getSiteUrl } from '@/lib/config/env'
import type {
  ShpOrderDraft, ShpPaymentIntent, ShpPaymentProvider, ShpPaymentResult, ShpRefundRequest, ShpRefundResult,
} from '@/modules/shop/lib/payments/provider'
import { getSquareCredentials, isSquareConfigured } from '@/modules/square-payment-for-shop/lib/env'
import { getSquareSettings } from '@/modules/square-payment-for-shop/lib/settings'
import * as sq from '@/modules/square-payment-for-shop/lib/square'
import { createSqpPayment, getSqpPaymentByOrderId, updateSqpPayment } from '@/modules/square-payment-for-shop/lib/db'
import { GENERIC_DECLINE, isShopSideFailure, shopperMessageForDecline } from '@/modules/square-payment-for-shop/lib/decline'
import { squareLogo } from '@/modules/square-payment-for-shop/lib/logo'

const METHOD_ID = 'SQUARE'
const RETURN_PATH = '/api/m/square-payment-for-shop/return'

function toMinorUnits(amount: number): number {
  return Math.round(amount * 100)
}

// Exported for the tests, along with readOnPagePayload and resultFromPayment
// below: these three are the whole of the on-page path's judgement, and none of
// them can be exercised through the provider itself without a live Square.
//
// Square caps an idempotency key at 45 characters, and a shop order id is a
// 36-character UUID on its own - so the key is a hash rather than a readable
// composite. It has to cover BOTH the order and the card token: keyed on the
// order alone, a shopper whose first card was declined would have their second
// card's charge answered with the first one's refusal, for ever.
export function paymentIdempotencyKey(orderId: string, sourceId: string): string {
  return `sqp-${createHash('sha256').update(`${orderId}:${sourceId}`).digest('hex').slice(0, 40)}`
}

// What the shopper sees named on their Square receipt, and on the hosted page.
function paymentDescription(prefix: string, orderNumber: string): string {
  const trimmed = prefix.trim()
  return trimmed ? `${trimmed} (${orderNumber})` : `Order ${orderNumber}`
}

// Offered at checkout only when the credentials are set AND the admin has turned
// the method on in its settings tab. Both come off one settings read, so the
// credentials checked are always the ones for the environment the shop is
// actually in - and for the way it has chosen to take the card, since on-page
// entry needs the Application ID as well.
async function isAvailable(): Promise<boolean> {
  const settings = await getSquareSettings()
  return settings.enabled && isSquareConfigured(settings.environment, settings.cardEntry)
}

// What the method is called at checkout and in the admin. The shop owner names
// it on the settings tab; the fixed `label` below is only what a shop that has
// left the box empty falls back to.
async function getLabel(): Promise<string> {
  const settings = await getSquareSettings()
  return settings.paymentDescription
}

// The publishable half of what the browser's Square SDK needs, and nothing that
// depends on an order. Shop puts this on its public checkout config, which is
// what lets the card fields draw the instant the shopper picks the method
// rather than waiting for a payment intent - and an intent cannot exist until
// the checkout is filled in and every compulsory box is ticked, so fields fed
// only by the intent appeared only after the shopper had agreed to the terms.
//
// null unless the shop is actually taking cards on its own checkout: on the
// hosted page there is nothing here to draw, and this goes to every shopper who
// loads the page whether they pay by card or not.
async function getClientFields(): Promise<Record<string, unknown> | null> {
  const settings = await getSquareSettings()
  if (!settings.enabled || settings.cardEntry !== 'on-page') return null
  const creds = getSquareCredentials(settings.environment)
  if (!creds.applicationId || !creds.locationId) return null
  // The Application ID is publishable by design - it is what the SDK boots
  // from. Nothing else here is a secret either: a location id and the name of
  // an environment.
  return {
    applicationId: creds.applicationId,
    locationId: creds.locationId,
    environment: settings.environment,
    // Which wallet buttons the review step may draw above "Place order". Both
    // are the same Square account and the same credentials as the card fields -
    // there is nothing extra to configure for Google Pay, and the only extra
    // for Apple Pay is proving the domain.
    //
    // Apple Pay is withheld until the domain-association file has been pasted
    // in, because Apple refuses its sheet on a domain it has not verified. A
    // button that always fails is worse than no button: the shopper reads it as
    // the shop being broken, not as Apple being fussy.
    wallets: {
      applePay: settings.walletsEnabled && settings.applePayDomainAssociation.trim().length > 0,
      googlePay: settings.walletsEnabled,
    },
  }
}

async function createIntent(order: ShpOrderDraft): Promise<ShpPaymentIntent> {
  const settings = await getSquareSettings()
  const description = paymentDescription(settings.paymentDescription, order.orderNumber)
  const currency = order.currency.toUpperCase()

  if (settings.cardEntry === 'on-page') {
    // The Square order is made now, before the shopper has typed a card. Two
    // reasons: the webhook matches a payment back to our row by the Square order
    // id and so needs it stored up front, and Square refuses a payment whose
    // amount disagrees with its order's total - which makes the figures checked
    // twice for nothing.
    const squareOrder = await sq.createOrder({
      amount: toMinorUnits(order.amount),
      currency,
      description,
      referenceId: order.orderNumber,
      idempotencyKey: `sqp-o-${order.orderId}`,
    })

    await createSqpPayment({
      orderId: order.orderId,
      orderNumber: order.orderNumber,
      squareOrderId: squareOrder.id,
      amount: order.amount,
      currency: order.currency,
    })

    return {
      providerOrderId: squareOrder.id,
      // Only what this ORDER adds. The Application ID and location came from
      // getClientFields long before this, when the shopper picked the method;
      // shop merges the two. The amount is the shop's own figure rather than
      // anything the client worked out, because it is what the bank is asked to
      // authorise.
      clientFields: {
        // Major units as a string: what Square's verifyBuyer() wants, and the
        // one place a float would round somebody's total by a penny.
        amount: order.amount.toFixed(2),
        currency,
      },
    }
  }

  const siteUrl = getSiteUrl()
  const link = await sq.createPaymentLink({
    amount: toMinorUnits(order.amount),
    currency,
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

type OnPagePayload = { sourceId: string; verificationToken?: string }

// The card token is compulsory - without one there is nothing to charge. The
// verification token is not, deliberately: it comes from the buyer's bank via
// Square's verifyBuyer(), and there are cards and regions for which that call
// returns nothing to send. Refusing the payment over a missing one would turn
// "your bank had no challenge for you" into a failed checkout.
export function readOnPagePayload(payload: unknown): OnPagePayload | null {
  if (!payload || typeof payload !== 'object') return null
  const { sourceId, verificationToken } = payload as Record<string, unknown>
  if (typeof sourceId !== 'string' || sourceId.length === 0) return null
  return {
    sourceId,
    verificationToken: typeof verificationToken === 'string' && verificationToken.length > 0 ? verificationToken : undefined,
  }
}

// Checks a Square payment against what the order actually costs. Never trust the
// payload: the client hands over a card token, not an outcome, and the figures
// have to be the shop's own on the way back as well as on the way out.
export function resultFromPayment(payment: sq.SqPayment, order: ShpOrderDraft): ShpPaymentResult {
  if (payment.amount !== toMinorUnits(order.amount)) return { success: false, error: 'Payment amount does not match this order.' }
  if (payment.currency.toUpperCase() !== order.currency.toUpperCase()) return { success: false, error: 'Payment currency does not match this order.' }
  // A payment that came back already failed, rather than one Square refused
  // just now - the hosted checkout path, and the on-page retry that finds a
  // failed payment sitting on the Square order. There is no error code to map
  // here, so it gets the wording every decline can honestly carry.
  if (sq.isPaymentFailed(payment.status)) return { success: false, error: GENERIC_DECLINE }
  return { success: true, pending: !sq.isPaymentCollected(payment.status), providerReference: payment.id }
}

// Charges the card token the on-page fields produced, and reports what happened.
// This is the only place an on-page payment is actually taken.
async function chargeOnPage(order: ShpOrderDraft, payload: unknown): Promise<ShpPaymentResult> {
  const parsed = readOnPagePayload(payload)
  if (!parsed) return { success: false, error: 'Please enter your card details, then place your order.' }

  const row = await getSqpPaymentByOrderId(order.orderId)
  if (!row?.squareOrderId) return { success: false, error: 'No Square payment was found for this order.' }

  // A payment already on the Square order is charged, not chargeable. This is
  // the guard against a double charge: the idempotency key covers a retry of the
  // SAME card token, but a shopper who presses the button again after a reply
  // that never arrived is holding a fresh token, and that key would let it
  // through as a second charge.
  const existing = await sq.getOrder(row.squareOrderId)
  if (existing.paymentId) {
    const payment = await sq.getPayment(existing.paymentId)
    await updateSqpPayment(row.id, { paymentId: payment.id, status: payment.status })
    return resultFromPayment(payment, order)
  }

  let payment: sq.SqPayment
  try {
    payment = await sq.createPayment({
      sourceId: parsed.sourceId,
      verificationToken: parsed.verificationToken,
      amount: toMinorUnits(order.amount),
      currency: order.currency.toUpperCase(),
      orderId: row.squareOrderId,
      referenceId: order.orderNumber,
      buyerEmail: order.customerEmail,
      idempotencyKey: paymentIdempotencyKey(order.orderId, parsed.sourceId),
    })
  } catch (err) {
    // Square's own wording is NOT passed through - that was the mistake this
    // replaces. `detail` is written for whoever reads the API logs, so a card
    // with no money on it reached the shopper as "Authorization error:
    // 'CARDHOLDER_INSUFFICIENT_PERMISSIONS'", which reads as a broken site
    // rather than a declined card. The code is mapped instead; see lib/decline.
    //
    // Logged with the code, because that is the part worth having later and the
    // part the shopper never sees. A declined card is an ordinary event on any
    // shop and gets a warning; something the shop itself has got wrong - a
    // revoked token, the wrong location - is an error, because the owner needs
    // to know.
    const detail = err instanceof Error ? err.message : String(err)
    if (isShopSideFailure(err)) {
      console.error(`[square-payment] payment for order ${order.orderNumber} failed on our side: ${detail}`)
    } else {
      console.warn(`[square-payment] card declined for order ${order.orderNumber}: ${detail}`)
    }
    // Nothing is marked failed here: the shop's confirm route leaves the draft
    // where it is, so trying again keeps the same order number instead of
    // burning a fresh one per attempt.
    return { success: false, error: shopperMessageForDecline(err) }
  }

  await updateSqpPayment(row.id, { paymentId: payment.id, status: payment.status })
  return resultFromPayment(payment, order)
}

// On-page: takes the money. Hosted: reports whether the shopper has been through
// Square's page yet - the redirect-return route and the webhook are the real
// confirmation path there. Either way the amount and currency are re-validated
// against the order and the client payload is never trusted for an outcome.
async function confirmPayment(order: ShpOrderDraft, payload: unknown): Promise<ShpPaymentResult> {
  const settings = await getSquareSettings()
  if (settings.cardEntry === 'on-page') return chargeOnPage(order, payload)

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
  await updateSqpPayment(row.id, { paymentId: payment.id, status: payment.status })
  return resultFromPayment(payment, order)
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
  getClientFields,
  confirmMode: 'auto',
  // No order until the card is authorised, in BOTH modes.
  //
  // On the hosted page the reason is the trip: plenty of shoppers close it
  // without typing a card, and an order written before they left would be an
  // order nobody had paid for, sitting in the owner's list looking exactly like
  // one somebody had.
  //
  // On-page the trip is gone but the reasoning holds and the shape is better
  // besides: the card is charged inside confirmPayment, so a decline leaves no
  // order at all rather than a PAYMENT_FAILED row for a basket the shopper is
  // about to pay for with their other card.
  orderCreation: 'on-payment',
  isAvailable,
  createIntent,
  confirmPayment,
  refundOrder,
}
