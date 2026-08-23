// Turning Square's refusal of a card into something the person holding it can
// act on.
//
// Square's `detail` field is written for whoever is reading the API logs, not
// for a shopper: a card with no money on it comes back as "Authorization error:
// 'CARDHOLDER_INSUFFICIENT_PERMISSIONS'". Printed straight onto a checkout that
// reads as the site being broken rather than as a card being declined, and the
// shopper's most likely next move is to leave rather than to try another card.
//
// So the CODE is mapped and the prose is discarded. Two rules follow from that,
// and both matter more than the length of the list below:
//
//  1. **An unmapped code must never reach the shopper.** Square adds codes, and
//     this file cannot be kept perfectly in step with them from here. Anything
//     unrecognised falls back to a plain "declined, try another card", which is
//     true of every decline and useful in a way a raw code never is. The code
//     itself goes to the server log, where whoever is debugging can find it.
//
//  2. **Never say more than Square told us.** "Not enough funds" is only said
//     when Square said INSUFFICIENT_FUNDS. Guessing why a bank refused, in
//     front of the customer, is its own kind of wrong - and card issuers
//     deliberately blur their real reason, which is why so many codes mean no
//     more than "ask your bank".
import { SquareApiError } from '@/modules/square-payment-for-shop/lib/square'

// What a shopper is told, by Square's own error code. Every line is written to
// be read by somebody standing at a checkout with a card in their hand: it says
// what happened and what to do next, and never names a code.
const MESSAGES: Record<string, string> = {
  // Money
  INSUFFICIENT_FUNDS: 'Your card was declined - there are not enough funds available. Please try another card.',
  TRANSACTION_LIMIT: 'Your card was declined because this order is over the limit set on it. Please try another card or check with your bank.',
  PAYMENT_LIMIT_EXCEEDED: 'Your card was declined because this order is over the limit set on it. Please try another card or check with your bank.',
  AMOUNT_TOO_HIGH: 'Your card was declined because this order is over the limit set on it. Please try another card or check with your bank.',

  // The card details themselves - the ones a shopper can actually correct
  CVV_FAILURE: 'The security code on the back of your card was not accepted. Please check it and try again.',
  VERIFY_CVV_FAILURE: 'The security code on the back of your card was not accepted. Please check it and try again.',
  ADDRESS_VERIFICATION_FAILURE: 'Your card was declined because the postcode does not match the one your bank has for this card. Please check the billing postcode and try again.',
  VERIFY_AVS_FAILURE: 'Your card was declined because the postcode does not match the one your bank has for this card. Please check the billing postcode and try again.',
  INVALID_POSTAL_CODE: 'That postcode was not accepted for this card. Please check it and try again.',
  INVALID_EXPIRATION: 'That expiry date was not accepted. Please check it and try again.',
  BAD_EXPIRATION: 'That expiry date was not accepted. Please check it and try again.',
  EXPIRATION_FAILURE: 'That expiry date was not accepted. Please check it and try again.',
  CARD_EXPIRED: 'That card has expired. Please try another card.',
  INVALID_CARD: 'Those card details were not accepted. Please check them and try again.',
  INVALID_CARD_DATA: 'Those card details were not accepted. Please check them and try again.',
  PAN_FAILURE: 'That card number was not accepted. Please check it and try again.',

  // Refused by the bank, for reasons the bank keeps to itself
  CARD_DECLINED: 'Your card was declined. Please try another card, or check with your bank.',
  GENERIC_DECLINE: 'Your card was declined. Please try another card, or check with your bank.',
  CARD_DECLINED_CALL_ISSUER: 'Your card was declined and your bank has asked to be contacted. Please ring the number on the back of your card, or try another one.',
  CARD_DECLINED_VERIFICATION_REQUIRED: 'Your bank needs to verify this payment before it can go through. Please try again, or use another card.',
  ALLOWABLE_PIN_TRIES_EXCEEDED: 'Your card has been locked by your bank after too many attempts. Please try another card, or contact your bank.',
  VOICE_FAILURE: 'Your bank has asked to be contacted before this payment can go through. Please ring the number on the back of your card, or try another card.',
  CARD_NOT_SUPPORTED: 'That kind of card is not accepted here. Please try another card.',
  UNSUPPORTED_CARD_BRAND: 'That kind of card is not accepted here. Please try another card.',

  // Nothing to do with the card - worth saying so, so nobody goes hunting for
  // a second card they did not need
  CARD_TOKEN_EXPIRED: 'This payment took too long and timed out. Please enter your card details again.',
  CARD_TOKEN_USED: 'This payment has already been attempted. Please enter your card details again.',
  TEMPORARY_ERROR: 'The payment could not be completed just now. Please try again in a moment.',
  RATE_LIMITED: 'The payment could not be completed just now. Please try again in a moment.',
  SERVICE_UNAVAILABLE: 'The payment could not be completed just now. Please try again in a moment.',
  GATEWAY_TIMEOUT: 'The payment could not be completed just now. Please try again in a moment.',
}

// True of every decline, and useful in a way a raw code never is.
export const GENERIC_DECLINE = 'Your card was declined. Please try another card, or check with your bank.'

// Something the shop has got wrong, not the shopper - a bad access token, the
// wrong location, an idempotency key reused. Saying "your card was declined"
// would be a lie that sends somebody off to find a second card that will fail
// in exactly the same way.
const SHOP_SIDE_CODES = new Set([
  'UNAUTHORIZED',
  'ACCESS_TOKEN_EXPIRED',
  'ACCESS_TOKEN_REVOKED',
  'FORBIDDEN',
  'INSUFFICIENT_SCOPES',
  'INVALID_LOCATION',
  'LOCATION_MISMATCH',
  'IDEMPOTENCY_KEY_REUSED',
  'BAD_REQUEST',
  'MISSING_REQUIRED_PARAMETER',
  'INVALID_VALUE',
])

const SHOP_SIDE_MESSAGE = 'Card payments are not set up correctly on this site, so this payment could not be taken. Please try another payment method, or get in touch with us.'

/** The sentence to show a shopper whose payment Square has just refused.
 *
 *  Exported for the tests. Deliberately never returns Square's own prose, and
 *  never returns a code. */
export function shopperMessageForDecline(error: unknown): string {
  if (!(error instanceof SquareApiError) || !error.code) return GENERIC_DECLINE
  const code = error.code.toUpperCase()
  if (SHOP_SIDE_CODES.has(code)) return SHOP_SIDE_MESSAGE
  return MESSAGES[code] ?? GENERIC_DECLINE
}

/** Whether this refusal is the shop's own fault rather than the card's. Only
 *  used to decide how loudly to log it: a declined card is an ordinary event on
 *  any shop and does not deserve an error in the log, while a revoked access
 *  token is something the owner needs to know about. */
export function isShopSideFailure(error: unknown): boolean {
  return error instanceof SquareApiError && !!error.code && SHOP_SIDE_CODES.has(error.code.toUpperCase())
}
