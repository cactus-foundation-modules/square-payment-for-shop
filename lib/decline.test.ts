import { describe, expect, it } from 'vitest'
import { GENERIC_DECLINE, isShopSideFailure, shopperMessageForDecline } from '@/modules/square-payment-for-shop/lib/decline'
import { SquareApiError } from '@/modules/square-payment-for-shop/lib/square'

// What a shopper is shown when their card is refused. This exists because a
// card with no money on it was reaching the checkout as "Authorization error:
// 'CARDHOLDER_INSUFFICIENT_PERMISSIONS'" - Square's `detail`, which is written
// for whoever reads the API logs. On a checkout that reads as a broken site
// rather than a declined card, and the shopper's next move is to leave.

function squareError(code: string | null, detail = "Authorization error: 'CARDHOLDER_INSUFFICIENT_PERMISSIONS'") {
  return new SquareApiError({ message: detail, code, category: 'PAYMENT_METHOD_ERROR', status: 402 })
}

describe('shopperMessageForDecline', () => {
  it('says what actually happened when Square told us', () => {
    expect(shopperMessageForDecline(squareError('INSUFFICIENT_FUNDS')))
      .toBe('Your card was declined - there are not enough funds available. Please try another card.')
  })

  it('points at the box the shopper can actually correct', () => {
    expect(shopperMessageForDecline(squareError('CVV_FAILURE'))).toContain('security code')
    expect(shopperMessageForDecline(squareError('CARD_EXPIRED'))).toContain('expired')
    expect(shopperMessageForDecline(squareError('ADDRESS_VERIFICATION_FAILURE'))).toContain('postcode')
  })

  // The whole point. Square adds codes and this map cannot be kept perfectly in
  // step from here, so an unmapped one must land on something true rather than
  // on the raw code.
  it('falls back to a plain decline for a code it has never seen', () => {
    expect(shopperMessageForDecline(squareError('SOME_NEW_CODE_SQUARE_ADDED'))).toBe(GENERIC_DECLINE)
    expect(shopperMessageForDecline(squareError(null))).toBe(GENERIC_DECLINE)
  })

  it('never leaks Square s own prose or the code itself', () => {
    for (const code of ['INSUFFICIENT_FUNDS', 'SOME_NEW_CODE', 'CARD_DECLINED', null]) {
      const message = shopperMessageForDecline(squareError(code))
      expect(message).not.toContain('CARDHOLDER_INSUFFICIENT_PERMISSIONS')
      expect(message).not.toContain('Authorization error')
      if (code) expect(message).not.toContain(code)
      // Nothing SCREAMING_SNAKE survived into the sentence.
      expect(message).not.toMatch(/[A-Z]{3,}_[A-Z]{3,}/)
    }
  })

  // "Your card was declined" would be a lie that sends somebody off to find a
  // second card which will fail in exactly the same way.
  it('does not blame the card when the fault is the shop s', () => {
    const message = shopperMessageForDecline(squareError('UNAUTHORIZED'))
    expect(message).toContain('not set up correctly')
    expect(message).not.toContain('declined')
    expect(isShopSideFailure(squareError('ACCESS_TOKEN_REVOKED'))).toBe(true)
    expect(isShopSideFailure(squareError('INSUFFICIENT_FUNDS'))).toBe(false)
  })

  it('survives anything that is not a Square error at all', () => {
    expect(shopperMessageForDecline(new Error('socket hang up'))).toBe(GENERIC_DECLINE)
    expect(shopperMessageForDecline(null)).toBe(GENERIC_DECLINE)
    expect(shopperMessageForDecline('nonsense')).toBe(GENERIC_DECLINE)
    expect(isShopSideFailure(new Error('socket hang up'))).toBe(false)
  })

  it('is not fussy about the case Square sends the code in', () => {
    expect(shopperMessageForDecline(squareError('insufficient_funds'))).toContain('not enough funds')
  })

  // Every message has to stand on its own on a checkout: say what happened, say
  // what to do next.
  it('always ends up somewhere a shopper can act on', () => {
    for (const code of ['INSUFFICIENT_FUNDS', 'CVV_FAILURE', 'CARD_DECLINED_CALL_ISSUER', 'TEMPORARY_ERROR', 'UNKNOWN']) {
      const message = shopperMessageForDecline(squareError(code))
      expect(message.length).toBeGreaterThan(20)
      expect(message).toMatch(/Please|contact|get in touch/i)
    }
  })
})
