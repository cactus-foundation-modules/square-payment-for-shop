import { describe, expect, it } from 'vitest'
import {
  paymentIdempotencyKey,
  readOnPagePayload,
  resultFromPayment,
} from '@/modules/square-payment-for-shop/lib/provider'
import type { ShpOrderDraft } from '@/modules/shop/lib/payments/provider'

// The three judgements the on-page card path makes on its own: what it will
// accept from the browser, what key it charges under, and whether the payment
// that came back is this order's.

const ORDER: ShpOrderDraft = {
  orderId: '9f2e1c44-6b0a-4a7e-9f0d-1a2b3c4d5e6f',
  orderNumber: 'SO-1042',
  amount: 484,
  currency: 'GBP',
  customerEmail: 'someone@example.com',
  customerName: 'Someone',
}

describe('readOnPagePayload', () => {
  it('takes a card token and its verification token', () => {
    expect(readOnPagePayload({ sourceId: 'cnon:abc', verificationToken: 'verf:xyz' }))
      .toEqual({ sourceId: 'cnon:abc', verificationToken: 'verf:xyz' })
  })

  // Square's verifyBuyer() has nothing to hand back for some cards and regions.
  // Refusing over a missing one would turn "your bank had no challenge for you"
  // into a failed checkout.
  it('accepts a card token with no verification token', () => {
    expect(readOnPagePayload({ sourceId: 'cnon:abc' })).toEqual({ sourceId: 'cnon:abc', verificationToken: undefined })
    expect(readOnPagePayload({ sourceId: 'cnon:abc', verificationToken: '' })).toEqual({ sourceId: 'cnon:abc', verificationToken: undefined })
  })

  it('refuses anything without a card token - there is nothing to charge', () => {
    expect(readOnPagePayload({ verificationToken: 'verf:xyz' })).toBeNull()
    expect(readOnPagePayload({ sourceId: '' })).toBeNull()
    expect(readOnPagePayload({ sourceId: 42 })).toBeNull()
    expect(readOnPagePayload(null)).toBeNull()
    expect(readOnPagePayload('cnon:abc')).toBeNull()
    expect(readOnPagePayload(undefined)).toBeNull()
  })
})

describe('paymentIdempotencyKey', () => {
  it('fits inside the 45 characters Square allows', () => {
    const key = paymentIdempotencyKey(ORDER.orderId, 'cnon:card-nonce-ok')
    expect(key.length).toBeLessThanOrEqual(45)
  })

  it('is the same key for a retry of the same card - so a lost reply cannot charge twice', () => {
    expect(paymentIdempotencyKey(ORDER.orderId, 'cnon:abc')).toBe(paymentIdempotencyKey(ORDER.orderId, 'cnon:abc'))
  })

  // The gap a key made from the order alone would leave: a shopper whose first
  // card was declined would have their SECOND card's charge answered with the
  // first one's refusal, for ever.
  it('is a different key for a different card on the same order', () => {
    expect(paymentIdempotencyKey(ORDER.orderId, 'cnon:abc')).not.toBe(paymentIdempotencyKey(ORDER.orderId, 'cnon:def'))
  })

  it('is a different key for the same card on a different order', () => {
    expect(paymentIdempotencyKey(ORDER.orderId, 'cnon:abc')).not.toBe(paymentIdempotencyKey('other-order', 'cnon:abc'))
  })
})

describe('resultFromPayment', () => {
  const payment = (patch: Partial<{ id: string; status: string; amount: number; currency: string }> = {}) => ({
    id: 'pay_1',
    status: 'COMPLETED',
    amount: 48400,
    currency: 'GBP',
    amountRefunded: 0,
    squareOrderId: 'sqo_1',
    ...patch,
  })

  it('accepts the right money, captured', () => {
    expect(resultFromPayment(payment(), ORDER)).toEqual({ success: true, pending: false, providerReference: 'pay_1' })
  })

  // APPROVED is authorised, not captured. The order is real but not paid, and
  // the webhook flips it when Square captures.
  it('reports an authorised-but-uncaptured payment as pending', () => {
    expect(resultFromPayment(payment({ status: 'APPROVED' }), ORDER))
      .toEqual({ success: true, pending: true, providerReference: 'pay_1' })
  })

  it('refuses a payment for the wrong money', () => {
    expect(resultFromPayment(payment({ amount: 100 }), ORDER).success).toBe(false)
    expect(resultFromPayment(payment({ amount: 99999 }), ORDER).success).toBe(false)
    expect(resultFromPayment(payment({ amount: 48399 }), ORDER).success).toBe(false)
  })

  it('refuses the right number in the wrong currency', () => {
    expect(resultFromPayment(payment({ currency: 'EUR' }), ORDER).success).toBe(false)
  })

  it('is not fussy about the case of a currency code', () => {
    expect(resultFromPayment(payment({ currency: 'gbp' }), ORDER).success).toBe(true)
  })

  it('refuses a declined or cancelled card', () => {
    expect(resultFromPayment(payment({ status: 'FAILED' }), ORDER).success).toBe(false)
    expect(resultFromPayment(payment({ status: 'CANCELED' }), ORDER).success).toBe(false)
  })

  // 19.99 * 100 is 1998.9999... in floating point, and a bare truncation would
  // refuse a perfectly good payment.
  it('rounds rather than truncates the order total', () => {
    expect(resultFromPayment(payment({ amount: 1999 }), { ...ORDER, amount: 19.99 }).success).toBe(true)
    expect(resultFromPayment(payment({ amount: 7 }), { ...ORDER, amount: 0.07 }).success).toBe(true)
  })
})
