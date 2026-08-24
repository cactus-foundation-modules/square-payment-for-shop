// Square's Web Payments SDK: the loader, and the slice of its shape this module
// actually uses. Shared by the card fields and the wallet buttons, which are
// two separate Puck blocks on one checkout page and must not each fetch and
// boot their own copy of it.
//
// Only what is called is typed. The SDK ships no types of its own worth having,
// and a hand-written mirror of the whole thing would be a lie within a release.

export type SqTokenResult = {
  // 'OK' when there is a token. 'CANCEL' is what a shopper who dismissed a
  // wallet sheet produces, and it is not an error - see the wallet buttons.
  status: string
  token?: string
  errors?: Array<{ message?: string; detail?: string }>
}

export type SqCard = {
  attach: (target: HTMLElement | string) => Promise<void>
  tokenize: () => Promise<SqTokenResult>
  destroy?: () => Promise<void>
  configure?: (options: Record<string, unknown>) => Promise<void>
}

// Apple Pay is deliberately NOT attached to anything: Square draws no button
// for it, because Apple requires the site to use Apple's own system-drawn
// button. Google Pay is the other way round - Square renders Google's button
// into whatever element it is attached to.
export type SqApplePay = {
  tokenize: () => Promise<SqTokenResult>
  destroy?: () => Promise<void>
}

export type SqGooglePay = {
  attach: (target: HTMLElement | string, options?: Record<string, unknown>) => Promise<void>
  tokenize: () => Promise<SqTokenResult>
  destroy?: () => Promise<void>
}

export type SqPaymentRequest = Record<string, unknown>

export type SqPayments = {
  card: (options?: Record<string, unknown>) => Promise<SqCard>
  applePay: (request: SqPaymentRequest) => Promise<SqApplePay>
  googlePay: (request: SqPaymentRequest) => Promise<SqGooglePay>
  paymentRequest: (options: Record<string, unknown>) => SqPaymentRequest
  verifyBuyer: (
    token: string,
    details: Record<string, unknown>
  ) => Promise<{ token?: string } | null>
}

declare global {
  interface Window {
    Square?: { payments: (applicationId: string, locationId: string) => SqPayments }
    // Apple's own gate. Asked before Square is, so an unsupported browser costs
    // nothing and produces no console noise: every browser that is not Safari
    // on an Apple device simply does not have this.
    ApplePaySession?: { canMakePayments: () => boolean }
  }
}

// Square serves the SDK from a different origin per environment, and the two are
// not interchangeable - the sandbox build refuses a production Application ID
// and vice versa, with an error about the application rather than about the
// script. Both origins are declared in this module's manifest (cspOrigins), so
// the site's Content-Security-Policy allows them for as long as it is installed.
function sdkUrl(environment: string): string {
  return environment === 'production'
    ? 'https://web.squarecdn.com/v1/square.js'
    : 'https://sandbox.web.squarecdn.com/v1/square.js'
}

// One load per page, however many times the shopper switches method and back,
// and however many of this module's components are on the page.
let sdkPromise: Promise<void> | null = null

export function loadSquareSdk(environment: string): Promise<void> {
  if (window.Square) return Promise.resolve()
  if (sdkPromise) return sdkPromise
  sdkPromise = new Promise<void>((resolve, reject) => {
    const script = document.createElement('script')
    script.src = sdkUrl(environment)
    script.async = true
    script.onload = () => resolve()
    script.onerror = () => {
      // Cleared so a shopper who tries again after their connection comes back
      // gets a fresh attempt rather than the cached rejection.
      sdkPromise = null
      reject(new Error('The card payment form could not be loaded. Please try again.'))
    }
    document.head.appendChild(script)
  })
  return sdkPromise
}

export function stringField(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}
