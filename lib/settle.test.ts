import { describe, expect, it } from 'vitest'
import { paymentMatchesOrder } from '@/modules/square-payment-for-shop/lib/settle'

// The check that was missing from the settlement path most payments actually
// take. A payment can only fulfil an order if it is for that order's money.

describe('paymentMatchesOrder', () => {
  it('accepts the right money in the right currency', () => {
    expect(paymentMatchesOrder({ amount: 48400, currency: 'GBP' }, { total: '484.00', currency: 'GBP' })).toBe(true)
  })

  it('takes the decimal strings the order layer hands it', () => {
    expect(paymentMatchesOrder({ amount: 160000, currency: 'GBP' }, { total: '1600.00', currency: 'GBP' })).toBe(true)
    expect(paymentMatchesOrder({ amount: 400, currency: 'GBP' }, { total: 4, currency: 'GBP' })).toBe(true)
  })

  it('refuses an underpayment', () => {
    expect(paymentMatchesOrder({ amount: 100, currency: 'GBP' }, { total: '484.00', currency: 'GBP' })).toBe(false)
  })

  it('refuses an overpayment too - it is still not this order', () => {
    expect(paymentMatchesOrder({ amount: 99999, currency: 'GBP' }, { total: '484.00', currency: 'GBP' })).toBe(false)
  })

  it('refuses a penny out', () => {
    expect(paymentMatchesOrder({ amount: 48399, currency: 'GBP' }, { total: '484.00', currency: 'GBP' })).toBe(false)
  })

  it('refuses the right number in the wrong currency', () => {
    expect(paymentMatchesOrder({ amount: 48400, currency: 'EUR' }, { total: '484.00', currency: 'GBP' })).toBe(false)
  })

  it('is not fussy about the case of a currency code', () => {
    expect(paymentMatchesOrder({ amount: 48400, currency: 'gbp' }, { total: '484.00', currency: 'GBP' })).toBe(true)
  })

  it('refuses an order whose total cannot be read as money', () => {
    expect(paymentMatchesOrder({ amount: 48400, currency: 'GBP' }, { total: null, currency: 'GBP' })).toBe(false)
    expect(paymentMatchesOrder({ amount: 48400, currency: 'GBP' }, { total: 'nonsense', currency: 'GBP' })).toBe(false)
  })

  // Floats: 19.99 * 100 is 1998.9999... and a bare truncation would reject a
  // perfectly good payment.
  it('rounds rather than truncates the order total', () => {
    expect(paymentMatchesOrder({ amount: 1999, currency: 'GBP' }, { total: '19.99', currency: 'GBP' })).toBe(true)
    expect(paymentMatchesOrder({ amount: 7, currency: 'GBP' }, { total: '0.07', currency: 'GBP' })).toBe(true)
  })
})
