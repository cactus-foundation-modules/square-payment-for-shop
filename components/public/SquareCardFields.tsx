'use client'

// Square's card fields, drawn on the shop's own checkout page. Registered on
// shop's 'shop.checkout-payment-fields' extension point under the SQUARE method
// id, and mounted by CheckoutPaymentClient once that method is chosen and its
// intent has come back. Only used when the owner has set card entry to
// "on-page"; the hosted-page mode never produces the clientFields this needs, so
// this component is never rendered for it.
//
// The card number is typed into Square's own iframes, served from Square's own
// origins - the same arrangement as the hosted page, minus the trip. Nothing
// here ever holds a card number, and nothing here decides whether a payment
// succeeded: tokenize() hands back a one-time token, shop posts it to the
// confirm route, and the server charges it.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ShopCheckoutPaymentFieldsProps } from '@/modules/shop/components/public/checkout-payment-fields'

type SqTokenResult = {
  status: string
  token?: string
  errors?: Array<{ message?: string; detail?: string }>
}

type SqCard = {
  attach: (target: HTMLElement | string) => Promise<void>
  tokenize: () => Promise<SqTokenResult>
  destroy?: () => Promise<void>
  configure?: (options: Record<string, unknown>) => Promise<void>
}

type SqPayments = {
  card: (options?: Record<string, unknown>) => Promise<SqCard>
  verifyBuyer: (
    token: string,
    details: Record<string, unknown>
  ) => Promise<{ token?: string } | null>
}

declare global {
  interface Window {
    Square?: { payments: (applicationId: string, locationId: string) => SqPayments }
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

// One load per page, however many times the shopper switches method and back.
let sdkPromise: Promise<void> | null = null

function loadSquareSdk(environment: string): Promise<void> {
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

// The card fields live inside Square's own iframes - several of them, one per
// sensitive field - and neither the site's stylesheet nor its CSS variables
// reach in there. Square wants concrete values, and honours them unevenly: on a
// dark checkout the card, expiry and CVV frames took our background while the
// postcode frame kept Square's white, and since our text colour DID apply
// everywhere, the shopper's postcode ended up white on white and invisible.
//
// So the box is deliberately LIGHT, in every theme, and the panel below is
// painted to match so there is no seam. Three attempts at persuading Square to
// go dark produced two broken checkouts and one unreadable field; a white card
// panel on a dark page is a normal thing that reads as a payment surface, and -
// far more to the point - it cannot render text invisibly, because it does not
// depend on Square honouring anything. Square's own defaults are dark-on-white
// too, so even a style object it rejects outright lands somewhere legible.
const PANEL_BG = '#ffffff'
const PANEL_TEXT = '#1a1a1a'
const PANEL_MUTED = '#6b6b6b'
const PANEL_BORDER = '#d5d5d5'
const PANEL_DANGER = '#c0392b'

function cardStyle(): Record<string, Record<string, string>> {
  // Square validates this object and REJECTS the whole card build if a selector
  // is given a property it does not allow there - the shopper is left looking
  // at "Loading the card form..." for ever. Keep to what Square documents:
  //   .input-container            borderColor, borderRadius, borderWidth
  //   .input-container.is-focus   borderColor
  //   .input-container.is-error   borderColor
  //   input                       backgroundColor, color, fontFamily, fontSize, fontWeight
  //   input::placeholder          color
  //   .message-text / .message-icon (and their .is-error twins)  color
  return {
    '.input-container': { borderColor: PANEL_BORDER, borderRadius: '6px' },
    '.input-container.is-focus': { borderColor: PANEL_TEXT },
    '.input-container.is-error': { borderColor: PANEL_DANGER },
    input: { color: PANEL_TEXT, backgroundColor: PANEL_BG, fontSize: '16px' },
    'input::placeholder': { color: PANEL_MUTED },
    '.message-text': { color: PANEL_MUTED },
    '.message-icon': { color: PANEL_MUTED },
    '.message-text.is-error': { color: PANEL_DANGER },
    '.message-icon.is-error': { color: PANEL_DANGER },
  }
}

// Square's client-side errors are usually written for a person ("Card number is
// not valid"), but not always - some come back as a bare code, or with one
// quoted inside them. Either way a shopper should never be shown one, so
// anything that reads like machine output is swapped for wording that does not.
//
// Same rule as the server side (see lib/decline.ts): say the true, useful,
// general thing rather than the precise, unreadable one.
function readableOrGeneric(message: unknown, fallback: string): string {
  if (typeof message !== 'string') return fallback
  const trimmed = message.trim()
  if (!trimmed) return fallback
  // A bare SCREAMING_SNAKE code, or a sentence with one quoted inside it.
  if (/^[A-Z0-9_]+$/.test(trimmed)) return fallback
  if (/'[A-Z0-9_]{4,}'/.test(trimmed)) return fallback
  return trimmed
}

function stringField(config: Record<string, unknown>, key: string): string {
  const value = config[key]
  return typeof value === 'string' ? value : ''
}

export function SquareCardFields({ config, payer, onError, registerSubmit }: ShopCheckoutPaymentFieldsProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<SqCard | null>(null)
  const paymentsRef = useRef<SqPayments | null>(null)
  const [ready, setReady] = useState(false)

  // Held in refs so the effects below can stay keyed on the things that actually
  // change the card fields. All three props are new values on every render of
  // the checkout - a keystroke in the contact box would otherwise tear the card
  // fields down and build them again, mid-typing.
  const payerRef = useRef(payer)
  const registerRef = useRef(registerSubmit)
  const onErrorRef = useRef(onError)

  // Declared before every other effect on purpose: effects run in the order they
  // are written, so this is what guarantees the ones below are reading this
  // render's props rather than the previous render's.
  useEffect(() => {
    payerRef.current = payer
    registerRef.current = registerSubmit
    onErrorRef.current = onError
  })

  const applicationId = stringField(config, 'applicationId')
  const locationId = stringField(config, 'locationId')
  const environment = stringField(config, 'environment')
  const amount = stringField(config, 'amount')
  const currency = stringField(config, 'currency')

  // Tokenises the card and asks the buyer's bank to verify them, then hands both
  // back for the server to charge. Everything it throws is written for the
  // shopper, because that is where the message ends up.
  const submit = useCallback(async (callConfig: Record<string, unknown>): Promise<unknown> => {
    const card = cardRef.current
    const payments = paymentsRef.current
    if (!card || !payments) throw new Error('The card payment form is not ready yet.')

    // Taken from what shop hands over at call time, NOT from the props this
    // component last rendered with. "Place order" creates the payment intent
    // and calls this in the same breath, without waiting for React to
    // re-render, so the closure below is routinely the one from before the
    // intent existed - and its amount is an empty string. Square answers a
    // verification request with no amount with "One or more of the arguments
    // needed are missing or invalid", which is a baffling thing to show
    // somebody who typed their card correctly.
    const money = {
      amount: stringField(callConfig, 'amount') || amount,
      currency: stringField(callConfig, 'currency') || currency,
    }
    if (!money.amount || !money.currency) throw new Error('This order is not ready to be paid for yet. Please try again in a moment.')

    const result = await card.tokenize()
    if (result.status !== 'OK' || !result.token) {
      const first = result.errors?.[0]
      throw new Error(readableOrGeneric(first?.message ?? first?.detail, 'Please check your card details and try again.'))
    }

    // Strong Customer Authentication. A UK or EEA card charged without this is
    // declined by the issuing bank with nothing the shopper can act on, so it is
    // attempted for every payment - and a shopper who fails or dismisses the
    // bank's challenge stops here rather than having their card charged.
    let verificationToken: string | undefined
    try {
      const verification = await payments.verifyBuyer(result.token, {
        amount: money.amount,
        currencyCode: money.currency,
        intent: 'CHARGE',
        billingContact: {
          givenName: payerRef.current.address.firstName,
          familyName: payerRef.current.address.lastName,
          email: payerRef.current.email,
          addressLines: [payerRef.current.address.line1, payerRef.current.address.line2 ?? ''].filter(Boolean),
          city: payerRef.current.address.city,
          state: payerRef.current.address.county ?? '',
          postalCode: payerRef.current.address.postcode,
          countryCode: payerRef.current.address.country || 'GB',
          phone: payerRef.current.address.phone ?? '',
        },
      })
      verificationToken = verification?.token
    } catch (err) {
      throw new Error(readableOrGeneric(
        err instanceof Error ? err.message : null,
        'Your bank could not verify this payment. Please try again, or use another card.',
      ))
    }

    return { sourceId: result.token, verificationToken }
  }, [amount, currency])

  useEffect(() => {
    if (!applicationId || !locationId) {
      onErrorRef.current('Card payments are not set up correctly on this site.')
      return
    }

    let cancelled = false
    let card: SqCard | null = null

    async function mount() {
      const container = containerRef.current
      if (!container) return
      await loadSquareSdk(environment)
      if (cancelled || !window.Square) return

      const payments = window.Square.payments(applicationId, locationId)

      // Built by falling back rather than in one go, and this is not belt and
      // braces - it is the lesson from having shipped a card form nobody could
      // use. Square VALIDATES the options and rejects the whole build over one
      // property it does not recognise, so a single wrong line in cardStyle()
      // is the difference between a checkout that looks slightly plain and a
      // checkout that shows "Loading the card form..." for ever.
      //
      // Nothing below the first attempt is essential to taking a payment. The
      // postcode is a courtesy (the shopper typed it two steps up this page,
      // and supplying it AT CREATION is the only thing that hides Square's own
      // postcode box - configure() after attach does not). The style is
      // cosmetic. So each is dropped in turn, worst case leaving Square's
      // default card form, which works.
      const postcode = payerRef.current.address.postcode.trim()
      // Style first and always: a rejected postalCode must never cost us the
      // styling, because the styling is what keeps the fields legible.
      const attempts: Array<Record<string, unknown>> = [
        ...(postcode ? [{ style: cardStyle(), postalCode: postcode }] : []),
        { style: cardStyle() },
        {},
      ]
      let created: SqCard | null = null
      let lastError: unknown = null
      for (const options of attempts) {
        try {
          created = await payments.card(options)
          break
        } catch (err) {
          lastError = err
          console.warn('[square-payment] card options rejected, retrying with fewer', err)
        }
      }
      if (!created) throw lastError instanceof Error ? lastError : new Error('The card payment form could not be built.')
      // The shopper is back on the checkout by the time this resolves only if
      // they have not switched method meanwhile. Tearing the fresh card down
      // rather than attaching it keeps a dead form off a page that has moved on.
      if (cancelled) { await created.destroy?.(); return }

      await created.attach(container)
      if (cancelled) { await created.destroy?.(); return }

      card = created
      cardRef.current = created
      paymentsRef.current = payments
      setReady(true)
      onErrorRef.current(null)
    }

    mount().catch((err) => {
      if (cancelled) return
      onErrorRef.current(err instanceof Error ? err.message : 'The card payment form could not be loaded.')
    })

    return () => {
      cancelled = true
      cardRef.current = null
      paymentsRef.current = null
      setReady(false)
      void card?.destroy?.()
    }
  }, [applicationId, locationId, environment])

  // Registered separately from the mount above so the handle is withdrawn the
  // moment this component leaves the page - a shopper who switches to bank
  // transfer must not have "Place order" reach for card fields that are gone.
  useEffect(() => {
    registerRef.current(submit)
    return () => registerRef.current(null)
  }, [submit])

  // No theme observer any more. The card panel is light in both themes on
  // purpose (see cardStyle), so there is nothing for a theme change to update -
  // and the observer was re-sending a style object on every toggle, which is one
  // more chance for Square to reject one and leave the form in a state nobody
  // asked for.

  // A postcode typed AFTER the card form was built. The form is drawn the
  // moment the shopper picks the method, which can be before they have finished
  // the address above it, so the value that hides Square's own postcode box is
  // not always known at creation. This is the catch-up.
  const postcode = payer.address.postcode.trim()
  useEffect(() => {
    if (!ready || !postcode) return
    cardRef.current?.configure?.({ postalCode: postcode })?.catch(() => {})
  }, [ready, postcode])

  return (
    <div style={{ display: 'grid', gap: '0.5rem' }}>
      {/* Painted to match the card fields inside it (see cardStyle), so the
          panel reads as one deliberate white payment surface rather than as a
          dark box with a white rectangle sitting in it. */}
      <div
        style={{
          background: PANEL_BG,
          border: `1px solid ${PANEL_BORDER}`,
          borderRadius: 8,
          padding: '0.75rem',
        }}
      >
        <div ref={containerRef} />
      </div>
      {ready ? (
        // Said here rather than by the checkout, because only this component
        // knows a card is what is being asked for - shop draws whatever a
        // payment module puts on the page and cannot promise anything about it.
        // Reassurance also belongs at the point of anxiety, which is these
        // fields, not a footer nobody reads. This line sits OUTSIDE the white
        // panel, so it keeps the page's own colours.
        <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem', margin: 0 }}>
          🔒 Card details go straight to Square, encrypted - they never touch this site.
        </p>
      ) : (
        <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem', margin: 0 }}>
          Loading the card form…
        </p>
      )}
    </div>
  )
}
