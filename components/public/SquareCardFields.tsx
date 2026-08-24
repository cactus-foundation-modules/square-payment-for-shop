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
import { loadSquareSdk, stringField, type SqCard, type SqPayments } from '@/modules/square-payment-for-shop/components/public/square-sdk'
import { readableOrGeneric } from '@/modules/square-payment-for-shop/components/public/square-messages'

// The card fields live inside Square's own iframes - several of them, one per
// sensitive field - and neither the site's stylesheet nor its CSS variables
// reach in there. Square wants concrete values, and honours them unevenly: on a
// dark checkout the card, expiry and CVV frames took our background while the
// postcode frame kept Square's white, and since our text colour DID apply
// everywhere, the shopper's postcode ended up white on white and invisible.
//
// That history is why the fallback ladder below always ends light: light
// matches Square's own dark-on-white defaults, so even a style object Square
// rejects outright lands somewhere legible. The dark palette itself is safe
// again as of 2026-08-24, verified against the production SDK standalone: the
// current UK card form draws no postcode frame at all (card, expiry and CVV
// only, postalCode supplied or not), and every frame it does draw honours the
// dark background and text together - the invisible-postcode failure cannot
// recur without the postcode frame that caused it.
//
// The theme is read once, at card creation, and never re-sent: a live restyle
// observer was tried and removed (one more chance for Square to reject a style
// object mid-checkout), and tearing the card down to rebuild it in the other
// palette would eat whatever digits the shopper had typed. A shopper who flips
// theme mid-payment keeps a panel in the old theme's colours - self-consistent,
// legible, and rare enough to be a fair trade.
type PanelPalette = {
  bg: string
  text: string
  muted: string
  border: string
  // Focus ring, deliberately its own colour rather than reusing text: Square
  // thickens the border on focus, and full text colour at that width reads as
  // a glaring outline on a dark panel rather than a highlight.
  focus: string
  danger: string
}

const LIGHT_PANEL: PanelPalette = {
  bg: '#ffffff',
  text: '#1a1a1a',
  muted: '#6b6b6b',
  border: '#d5d5d5',
  focus: '#1a1a1a',
  danger: '#c0392b',
}

// Deliberately neutral rather than sampled from the site's CSS variables:
// Square validates colour values, and a site token that resolves to oklch() or
// a colour-mix() is a rejected build and a checkout stuck on "Loading the card
// form...". Fixed hex cannot do that.
const DARK_PANEL: PanelPalette = {
  bg: '#1c1c1e',
  text: '#f2f2f2',
  muted: '#a3a3a3',
  border: '#3f3f42',
  focus: '#8a8a90',
  danger: '#e06c5f',
}

// Whether the page behind the card fields is dark. NOT the data-theme
// attribute: a site whose brand palette is dark paints a dark checkout while
// data-theme still says "light", and the question that decides the palette is
// what colour actually surrounds the fields. So: walk up from the container to
// the first element with an opaque background and measure it. The attribute is
// only the tie-breaker when nothing opaque is found.
function isDarkBackdrop(el: HTMLElement | null): boolean {
  for (let node = el; node; node = node.parentElement) {
    const bg = getComputedStyle(node).backgroundColor
    // Computed backgroundColor comes back as rgb()/rgba() in every browser
    // this runs in; anything else (unlikely) just moves on up the tree.
    const m = bg.match(/rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,/\s]+([\d.]+))?\s*\)/)
    if (!m) continue
    const alpha = m[4] === undefined ? 1 : parseFloat(m[4])
    if (alpha < 0.5) continue
    const lum = (0.2126 * Number(m[1]) + 0.7152 * Number(m[2]) + 0.0722 * Number(m[3])) / 255
    return lum < 0.5
  }
  return document.documentElement.getAttribute('data-theme') === 'dark'
}

function cardStyle(palette: PanelPalette): Record<string, Record<string, string>> {
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
    '.input-container': { borderColor: palette.border, borderRadius: '6px', borderWidth: '1px' },
    '.input-container.is-focus': { borderColor: palette.focus },
    '.input-container.is-error': { borderColor: palette.danger },
    input: { color: palette.text, backgroundColor: palette.bg, fontSize: '16px' },
    'input::placeholder': { color: palette.muted },
    '.message-text': { color: palette.muted },
    '.message-icon': { color: palette.muted },
    '.message-text.is-error': { color: palette.danger },
    '.message-icon.is-error': { color: palette.danger },
  }
}

export function SquareCardFields({ config, payer, onError, registerSubmit }: ShopCheckoutPaymentFieldsProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  // The component's outermost element - where the backdrop measurement starts
  // (see isDarkBackdrop; everything inside it is this component's own paint).
  const outerRef = useRef<HTMLDivElement>(null)
  const cardRef = useRef<SqCard | null>(null)
  const paymentsRef = useRef<SqPayments | null>(null)
  const [ready, setReady] = useState(false)
  // Whatever palette the card was actually built with - the panel behind the
  // iframes is painted from this, so the two can never disagree even when the
  // build fell back to a plainer attempt than the theme asked for.
  const [panel, setPanel] = useState<PanelPalette>(LIGHT_PANEL)

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
      // Measured from the component's root, NOT the container: the container
      // sits inside the panel this component itself paints (white before the
      // first build), and measuring through it would always answer "light".
      const themed = isDarkBackdrop(outerRef.current?.parentElement ?? null) ? DARK_PANEL : LIGHT_PANEL
      // Style first and always: a rejected postalCode must never cost us the
      // styling, because the styling is what keeps the fields legible. The
      // ladder ends light regardless of theme - light is the palette that can
      // never render invisibly (see the palette notes above cardStyle).
      const attempts: Array<{ options: Record<string, unknown>; palette: PanelPalette }> = [
        ...(postcode ? [{ options: { style: cardStyle(themed), postalCode: postcode }, palette: themed }] : []),
        { options: { style: cardStyle(themed) }, palette: themed },
        ...(themed !== LIGHT_PANEL ? [{ options: { style: cardStyle(LIGHT_PANEL) }, palette: LIGHT_PANEL }] : []),
        { options: {}, palette: LIGHT_PANEL },
      ]
      let created: SqCard | null = null
      let chosen: PanelPalette = LIGHT_PANEL
      let lastError: unknown = null
      for (const attempt of attempts) {
        try {
          created = await payments.card(attempt.options)
          chosen = attempt.palette
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
      setPanel(chosen)
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

  // No theme observer, on purpose. The theme is read once, when the card is
  // built (see the palette notes above cardStyle): a live restyle was one more
  // chance for Square to reject a style object mid-checkout, and a rebuild
  // would eat the digits the shopper had typed.

  // A postcode typed AFTER the card form was built. The form is drawn the
  // moment the shopper picks the method, which can be before they have finished
  // the address above it, so the postcode is not always known at creation.
  // This is the catch-up - it feeds Square the AVS value; the current UK form
  // draws no postcode field either way.
  const postcode = payer.address.postcode.trim()
  useEffect(() => {
    if (!ready || !postcode) return
    cardRef.current?.configure?.({ postalCode: postcode })?.catch(() => {})
  }, [ready, postcode])

  return (
    <div ref={outerRef} style={{ display: 'grid', gap: '0.5rem' }}>
      {/* Painted from the palette the card was ACTUALLY built with (not the
          one the theme asked for), so panel and fields read as one deliberate
          payment surface even when the build fell back to light. */}
      <div
        style={{
          background: panel.bg,
          border: `1px solid ${panel.border}`,
          borderRadius: 8,
          padding: '0.75rem',
          // The load-bearing line for dark mode, found the hard way. Square's
          // iframes declare a light colour-scheme; on a page whose own
          // colour-scheme is dark, the browser deems the two mismatched and
          // paints an opaque WHITE backdrop behind each cross-origin iframe
          // (standard behaviour, Chrome and Safari alike) - which blanks out
          // every colour Square was correctly told to draw. Forcing this
          // subtree light makes the schemes match, the backdrop transparent,
          // and the style object visible. Affects nothing else: the only
          // things in here are the iframes.
          colorScheme: 'light',
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
