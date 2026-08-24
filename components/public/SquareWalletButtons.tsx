'use client'

// Apple Pay and Google Pay, drawn on the shop's own checkout directly above
// "Place order". Registered on shop's 'shop.checkout-wallet-buttons' extension
// point under the SQUARE method id, and mounted by the review step once that
// method is the one chosen.
//
// Why these are not part of SquareCardFields, which is where the card is typed:
// a wallet has to be told the total BEFORE it is clicked (its sheet quotes the
// figure the shopper approves), and there is no payment intent that early. The
// review step is the one block that already knows the total. See shop's
// components/public/checkout-wallet-buttons.ts for the whole of that reasoning.
//
// Nothing here holds a card number, and nothing here decides whether a payment
// succeeded: tokenize() hands back a one-time token, shop posts it to the
// confirm route with the order, and the server charges it - re-checking the
// amount and the currency against the order as it goes.
import { useCallback, useEffect, useRef, useState } from 'react'
import type { ShopCheckoutWalletButtonsProps } from '@/modules/shop/components/public/checkout-wallet-buttons'
import {
  loadSquareSdk, stringField,
  type SqApplePay, type SqGooglePay, type SqPayments, type SqTokenResult,
} from '@/modules/square-payment-for-shop/components/public/square-sdk'
import { readableOrGeneric } from '@/modules/square-payment-for-shop/components/public/square-messages'

// Square renders Google's own button into this element. Given an id rather than
// passed as a node because that is what Square's own examples attach to, and
// the SDK is fussier about the element than it lets on.
const GOOGLE_PAY_ELEMENT_ID = 'sqp-google-pay-button'

// Both buttons are drawn to the same size so they sit as a pair rather than as
// two things that happened to land next to each other.
const BUTTON_HEIGHT = 48
const BUTTON_RADIUS = 8

// Apple draws its button itself, through a -webkit-appearance value that only
// Safari understands. It cannot be expressed in a React style object, so it
// goes in a stylesheet of its own - and nothing about it is a colour of ours to
// tokenise: the whole point of the control is that it looks like every other
// Apple Pay button on every other site.
//
// The second rule takes Google's hover tint off, so the two buttons behave the
// same on a mouse. Google's hover is not a `:hover` rule at all - its script
// toggles a `.hover` CLASS, styled `.gpay-button.black.hover{background-color:
// rgb(60,64,67)}` - and Apple's button has no hover state to match it with,
// because the system draws that control and offers no hook for one. So the
// only way the pair can agree is Google's coming off.
//
// Two deliberate details. It is the background-COLOR longhand, never the
// shorthand: the logo is a background IMAGE, and that is exactly how the
// site's own button styling erased it (see this module's 0.1.20). And it is
// scoped by the container's id, whose specificity already beats Google's two
// classes - so no `!important`, and Google's `.focus` outline and `.active`
// press tint are both left alone. The press state staying is the point rather
// than an oversight: Apple's native button has one too, so keeping it is what
// matching actually means.
const WALLET_CSS = `
.sqp-apple-pay-button {
  -webkit-appearance: -apple-pay-button;
  -apple-pay-button-type: buy;
  -apple-pay-button-style: black;
  width: 100%;
  height: ${BUTTON_HEIGHT}px;
  border: 0;
  border-radius: ${BUTTON_RADIUS}px;
  cursor: pointer;
}
#${GOOGLE_PAY_ELEMENT_ID} .gpay-button.hover { background-color: #000; }
`

// What Square is asked to draw Google's button as. Chosen to match the Apple
// Pay button beside it rather than to be interesting: black like Apple's, the
// long "Buy with G Pay" wording rather than the bare logo, filling the column
// it is given, the same corner radius, and no border - Google's default border
// is a grey ring Apple's button does not have, which is what made the pair look
// mismatched.
const GOOGLE_PAY_BUTTON_OPTIONS = {
  buttonColor: 'black',
  buttonType: 'long',
  buttonSizeMode: 'fill',
  buttonRadius: BUTTON_RADIUS,
  buttonBorderType: 'no_border',
} as const

// Which wallets the owner has switched on, off the provider's client fields.
// Apple Pay is only ever offered once the domain-association file has been
// pasted in (the provider checks that, not this), because Apple refuses the
// sheet on an unverified domain and a button that always fails is worse than no
// button at all.
function walletFlags(config: Record<string, unknown>): { applePay: boolean; googlePay: boolean } {
  const wallets = config.wallets
  if (!wallets || typeof wallets !== 'object') return { applePay: false, googlePay: false }
  const w = wallets as Record<string, unknown>
  return { applePay: w.applePay === true, googlePay: w.googlePay === true }
}

export function SquareWalletButtons({ config, getPayer, amount, currency, disabled, onError, placeOrder }: ShopCheckoutWalletButtonsProps) {
  const paymentsRef = useRef<SqPayments | null>(null)
  const applePayRef = useRef<SqApplePay | null>(null)
  const googlePayRef = useRef<SqGooglePay | null>(null)
  const googleContainerRef = useRef<HTMLDivElement>(null)
  const [applePayReady, setApplePayReady] = useState(false)
  const [googlePayReady, setGooglePayReady] = useState(false)

  // Held in refs so the mount effect below is keyed only on what actually
  // rebuilds a wallet. `disabled` in particular changes the moment the last
  // tickbox is ticked, and rebuilding Google's button under a shopper's finger
  // at that exact moment is its own bug.
  const disabledRef = useRef(disabled)
  const getPayerRef = useRef(getPayer)
  const onErrorRef = useRef(onError)
  const placeOrderRef = useRef(placeOrder)
  useEffect(() => {
    disabledRef.current = disabled
    getPayerRef.current = getPayer
    onErrorRef.current = onError
    placeOrderRef.current = placeOrder
  })

  const applicationId = stringField(config, 'applicationId')
  const locationId = stringField(config, 'locationId')
  const environment = stringField(config, 'environment')
  const { applePay: wantApplePay, googlePay: wantGooglePay } = walletFlags(config)
  const countryCode = (getPayer().address.country || 'GB').toUpperCase()

  // Everything a tokenised wallet payment goes through between the shopper
  // approving it and shop placing the order. Written for the shopper, because
  // that is where anything it throws ends up.
  const completePayment = useCallback(async (result: SqTokenResult) => {
    // A dismissed sheet is not a failure and must not be dressed up as one -
    // the shopper closed it, and they can see that they closed it.
    if (result.status === 'CANCEL') return
    if (result.status !== 'OK' || !result.token) {
      const first = result.errors?.[0]
      onErrorRef.current(readableOrGeneric(first?.message ?? first?.detail, 'That payment could not be completed. Please try again, or pay by card.'))
      return
    }

    // Strong Customer Authentication, attempted for the same reason the card
    // fields attempt it: a UK or EEA payment charged without it can be declined
    // by the issuer with nothing the shopper can act on.
    //
    // Unlike the card path, a failure here does NOT stop the payment. A wallet
    // has already authenticated the person - a fingerprint, a face, a device
    // passcode - and the token carries that with it, so throwing away a payment
    // the shopper has genuinely approved because a second verification hiccuped
    // costs an order and gains nothing.
    let verificationToken: string | undefined
    try {
      const payer = getPayerRef.current()
      const verification = await paymentsRef.current?.verifyBuyer(result.token, {
        amount: amount.toFixed(2),
        currencyCode: currency,
        intent: 'CHARGE',
        billingContact: {
          givenName: payer.address.firstName,
          familyName: payer.address.lastName,
          email: payer.email,
          addressLines: [payer.address.line1, payer.address.line2 ?? ''].filter(Boolean),
          city: payer.address.city,
          state: payer.address.county ?? '',
          postalCode: payer.address.postcode,
          countryCode: payer.address.country || 'GB',
          phone: payer.address.phone ?? '',
        },
      })
      verificationToken = verification?.token
    } catch (err) {
      console.warn('[square-payment] wallet buyer verification skipped', err)
    }

    // Same payload shape as the card fields hand over, because it is charged by
    // the same code on the server: a one-time source id, and a verification
    // token where there is one.
    placeOrderRef.current({ sourceId: result.token, verificationToken })
  }, [amount, currency])

  // Apple Pay insists tokenize() is called inside the click handler itself,
  // with nothing awaited before it - Safari drops the user gesture otherwise
  // and the sheet silently never opens. So the handler does exactly that and
  // nothing else; every await lives in completePayment, on the far side of it.
  const payWithApple = useCallback(() => {
    if (disabledRef.current) return
    const applePay = applePayRef.current
    if (!applePay) return
    onErrorRef.current(null)
    applePay.tokenize().then(completePayment).catch((err) => {
      onErrorRef.current(readableOrGeneric(
        err instanceof Error ? err.message : null,
        'Apple Pay could not complete that payment. Please try again, or pay by card.',
      ))
    })
  }, [completePayment])

  const payWithGoogle = useCallback(() => {
    if (disabledRef.current) return
    const googlePay = googlePayRef.current
    if (!googlePay) return
    onErrorRef.current(null)
    googlePay.tokenize().then(completePayment).catch((err) => {
      onErrorRef.current(readableOrGeneric(
        err instanceof Error ? err.message : null,
        'Google Pay could not complete that payment. Please try again, or pay by card.',
      ))
    })
  }, [completePayment])

  useEffect(() => {
    if (!applicationId || !locationId) return
    if (!wantApplePay && !wantGooglePay) return
    // A wallet sheet quotes a figure, so there is nothing to build until there
    // is one. Carriage is priced after the postcode is typed, so this is the
    // ordinary state of the checkout for a while, not an error.
    if (!(amount > 0)) return

    let cancelled = false
    let apple: SqApplePay | null = null
    let google: SqGooglePay | null = null

    async function mount() {
      await loadSquareSdk(environment)
      if (cancelled || !window.Square) return
      const payments = window.Square.payments(applicationId, locationId)
      paymentsRef.current = payments

      // Rebuilt whenever the total changes rather than updated in place: the
      // amount is baked into the request Square hands the wallet, and a sheet
      // quoting last minute's total is the one mistake this must not make.
      const paymentRequest = payments.paymentRequest({
        countryCode,
        currencyCode: currency,
        total: { amount: amount.toFixed(2), label: 'Total' },
      })

      // Apple's own gate first, so every browser that is not Safari on an Apple
      // device costs nothing and logs nothing.
      if (wantApplePay && window.ApplePaySession?.canMakePayments()) {
        try {
          apple = await payments.applePay(paymentRequest)
          if (cancelled) { await apple.destroy?.(); apple = null }
          else { applePayRef.current = apple; setApplePayReady(true) }
        } catch (err) {
          // Not shown to the shopper: a device that cannot do Apple Pay is not
          // a fault, it is most devices. The button simply is not offered.
          console.warn('[square-payment] Apple Pay unavailable', err)
        }
      }

      if (wantGooglePay && googleContainerRef.current) {
        try {
          google = await payments.googlePay(paymentRequest)
          if (cancelled) { await google.destroy?.(); google = null }
          else {
            await google.attach(`#${GOOGLE_PAY_ELEMENT_ID}`, { ...GOOGLE_PAY_BUTTON_OPTIONS })
            if (cancelled) { await google.destroy?.(); google = null }
            else { googlePayRef.current = google; setGooglePayReady(true) }
          }
        } catch (err) {
          console.warn('[square-payment] Google Pay unavailable', err)
        }
      }
    }

    mount().catch((err) => {
      // The card fields below say their own piece if the SDK is genuinely
      // unreachable. A wallet that cannot be built is a missing shortcut, not a
      // broken checkout, so it stays quiet and leaves "Place order" to it.
      console.warn('[square-payment] wallet buttons could not be built', err)
    })

    return () => {
      cancelled = true
      applePayRef.current = null
      googlePayRef.current = null
      setApplePayReady(false)
      setGooglePayReady(false)
      void apple?.destroy?.()
      void google?.destroy?.()
    }
  }, [applicationId, locationId, environment, wantApplePay, wantGooglePay, amount, currency, countryCode])

  // Google's button is rendered by Square INTO the container below, so the
  // container has to be laid out before the effect above attaches to it - an
  // element inside a display:none subtree gets no width, and Google's button
  // renders itself into that width. So the block is always laid out, and merely
  // made invisible and flat until a wallet is actually ready.
  const anythingToShow = applePayReady || googlePayReady

  return (
    <div
      // Keeps the site's own button, link and image styling off both of these.
      // Neither button is ours to paint: Apple's is a control the operating
      // system draws, Google's is Google's, and both come with brand rules
      // about it. Before this, a site with a hover colour set under Styles >
      // Buttons turned the Google Pay button into a plain coloured rectangle
      // with the logo scrubbed off, because that rule is `!important` and its
      // `background` shorthand takes the logo with it.
      data-cactus-unstyled=""
      style={{
        display: 'grid',
        gap: '0.5rem',
        // visibility rather than display: the container keeps its width, which
        // is the one thing Google's button needs to draw itself correctly.
        ...(anythingToShow ? {} : { visibility: 'hidden' as const, height: 0, overflow: 'hidden' as const }),
      }}
      aria-hidden={anythingToShow ? undefined : true}
    >
      <style>{WALLET_CSS}</style>
      <div
        style={{
          display: 'grid',
          // Side by side where the device offers both - which is rare, since
          // Apple Pay is Safari's and Google Pay is everybody else's - and one
          // full-width button the rest of the time.
          gridTemplateColumns: applePayReady && googlePayReady ? 'repeat(2, minmax(0, 1fr))' : '1fr',
          gap: '0.5rem',
          // Held shut by exactly what holds "Place order" shut. Both halves are
          // needed: the opacity says so, and pointer-events means Google's own
          // button cannot be clicked through the styling.
          opacity: disabled ? 0.55 : 1,
          pointerEvents: disabled ? 'none' : 'auto',
        }}
        aria-disabled={disabled || undefined}
      >
        {applePayReady && (
          <button type="button" className="sqp-apple-pay-button" onClick={payWithApple} aria-label="Pay with Apple Pay" />
        )}
        {/* Square renders Google's own button in here. The click is caught on
            the container because the button inside it is Square's, not ours.
            The height is ours though: Google's button fills what it is given
            (buttonSizeMode 'fill'), and what it is given has to be the height
            Apple's button is, or the pair sit at two different sizes. */}
        {wantGooglePay && (
          <div
            id={GOOGLE_PAY_ELEMENT_ID}
            ref={googleContainerRef}
            onClick={payWithGoogle}
            style={{ height: BUTTON_HEIGHT }}
          />
        )}
      </div>
      {/* Only drawn when a wallet actually is: "or" above a lone button reads as
          a missing option rather than a choice. The card fields sit directly
          below this, which is what it is pointing at. */}
      <p style={{ color: 'var(--color-text-muted)', fontSize: '0.8125rem', margin: 0, textAlign: 'center' }}>
        or pay by card below
      </p>
    </div>
  )
}
