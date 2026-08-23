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

function readToken(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || fallback
}

// The card fields live inside Square's iframe, so the site's stylesheet cannot
// reach them and CSS variables mean nothing in there - Square wants concrete
// values. They are read off the page's own tokens rather than written as hex, so
// the box matches the inputs above it and follows the site into dark mode
// instead of sitting there as a white rectangle on a dark checkout.
function cardStyle(): Record<string, Record<string, string>> {
  const text = readToken('--color-text', '#111111')
  const muted = readToken('--color-text-muted', '#666666')
  const border = readToken('--color-border', '#cccccc')
  const surface = readToken('--color-surface', '#ffffff')
  const danger = readToken('--color-danger', '#c0392b')
  const accent = readToken('--color-primary', text)
  // Square validates this object and REJECTS the whole card build if a selector
  // is given a property it does not allow there - the shopper is left looking at
  // "Loading the card form..." for ever. `.input-container` takes border
  // properties only; backgroundColor belongs on `input`, and putting it on the
  // container is what broke the form in 0.1.14. Keep to what Square documents:
  //   .input-container            borderColor, borderRadius, borderWidth
  //   .input-container.is-focus   borderColor
  //   .input-container.is-error   borderColor
  //   input                       backgroundColor, color, fontFamily, fontSize, fontWeight
  //   input::placeholder          color
  //   .message-text / .message-icon (and their .is-error twins)  color
  return {
    '.input-container': { borderColor: border, borderRadius: '6px' },
    '.input-container.is-focus': { borderColor: accent },
    '.input-container.is-error': { borderColor: danger },
    input: { color: text, backgroundColor: surface, fontSize: '16px' },
    'input::placeholder': { color: muted },
    '.message-text': { color: muted },
    '.message-icon': { color: muted },
    '.message-text.is-error': { color: danger },
    '.message-icon.is-error': { color: danger },
  }
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
  const submit = useCallback(async (): Promise<unknown> => {
    const card = cardRef.current
    const payments = paymentsRef.current
    if (!card || !payments) throw new Error('The card payment form is not ready yet.')

    const result = await card.tokenize()
    if (result.status !== 'OK' || !result.token) {
      const first = result.errors?.[0]
      throw new Error(first?.message ?? first?.detail ?? 'Please check your card details and try again.')
    }

    // Strong Customer Authentication. A UK or EEA card charged without this is
    // declined by the issuing bank with nothing the shopper can act on, so it is
    // attempted for every payment - and a shopper who fails or dismisses the
    // bank's challenge stops here rather than having their card charged.
    let verificationToken: string | undefined
    try {
      const verification = await payments.verifyBuyer(result.token, {
        amount,
        currencyCode: currency,
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
      throw new Error(err instanceof Error ? err.message : 'Your bank could not verify this payment.')
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
      const attempts: Array<Record<string, unknown>> = [
        { style: cardStyle(), ...(postcode ? { postalCode: postcode } : {}) },
        ...(postcode ? [{ postalCode: postcode }] : []),
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

  // Follows the site into dark mode. The fields are Square's iframe, so the
  // site's own stylesheet never reaches them - without this the box keeps the
  // colours it was built with and a dark checkout gets a white card form.
  useEffect(() => {
    const observer = new MutationObserver(() => {
      // Cosmetic, and allowed to fail: a rejected style must never be the reason
      // somebody cannot pay.
      cardRef.current?.configure?.({ style: cardStyle() })?.catch(() => {})
    })
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class', 'data-theme'] })
    return () => observer.disconnect()
  }, [])

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
      <div ref={containerRef} />
      {ready ? (
        // Said here rather than by the checkout, because only this component
        // knows a card is what is being asked for - shop draws whatever a
        // payment module puts on the page and cannot promise anything about it.
        // Reassurance also belongs at the point of anxiety, which is these
        // fields, not a footer nobody reads.
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
