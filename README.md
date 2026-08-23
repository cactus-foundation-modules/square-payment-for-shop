<p align="center">
  <img src="module-art.webp" alt="Square Payments for Shop" width="640" />
</p>

# Square Payments for Shop

Adds **card payment via Square** as a checkout payment method in the Cactus
Shop. No card data ever touches the site either way - which keeps PCI scope to
the lightest tier - and the shop owner chooses where the shopper types it:

- **On your own checkout** - Square's
  [Web Payments SDK](https://developer.squareup.com/docs/web-payments/overview)
  draws its card fields underneath the payment method, in Square's own frames.
  The shopper never leaves the page, and pressing *Place order* takes the
  payment. Needs the Square **Application ID** as well as the access token.
- **On Square's hosted page** - the shopper is redirected to squareup.com and
  back, on Square's
  [Payment Links API](https://developer.squareup.com/docs/checkout-api/payment-links).
  This is what the module did before there was a choice, and it stays the
  default so an existing shop's card payments do not change underneath it.

With the [Payments](https://developer.squareup.com/reference/square/payments-api),
[Orders](https://developer.squareup.com/reference/square/orders-api) and
[Refunds](https://developer.squareup.com/reference/square/refunds-api) APIs
behind both.

- **Table prefix:** `sqp_`
- **Depends on:** the `shop` module (`>= 0.1.301`, which exposes the
  `shop.payment-providers` and `shop.checkout-payment-fields` extension points)

## How it works

**On your own checkout.** At checkout the shopper picks *Card payment
(Square)*; the module creates a Square order for the total and hands the
browser's Square SDK the (publishable) Application ID to draw its card fields
with. Pressing *Place order* tokenises the card, asks the shopper's bank to
verify them, and sends both to the server - which is where the card is actually
charged. Nothing the browser says is taken as proof of anything.

**On Square's hosted page.** The module creates a Square payment link for the
order total and redirects the shopper to Square to pay. On return, and via
Square webhooks, the order is confirmed.

Either way: no order exists until the card has been authorised, so a shopper
who abandons the checkout - or whose card is declined - leaves nothing in the
owner's orders list. Once the payment lands the order is created, held at
*Awaiting confirmation* if the card is authorised but not yet captured, then
flipped to *Paid* with the usual fulfilment (email, stock, downloads). Refunds
are issued from the order screen like any other provider.

Cards issued in the UK and EEA generally need Strong Customer Authentication.
The hosted page handles that itself; on-page, the module calls the SDK's
`verifyBuyer()` and passes the resulting token with the charge, so the bank may
show its own confirmation step.

## Configuration

Set these environment variables (managed on **Shop → Payments → Square** in
the admin, or in `.env.local` for local development):

| Variable | Purpose |
|----------|---------|
| `SQUARE_ACCESS_TOKEN` | Production API access token. |
| `SQUARE_APPLICATION_ID` | Production Application ID. Publishable - it is handed to the browser. Only on-page card entry uses it, but there it gates the method. |
| `SQUARE_LOCATION_ID` | Production location payments are taken under. |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | Production webhook subscription's signature key. Optional. |
| `SQUARE_SANDBOX_ACCESS_TOKEN` | Sandbox API access token. |
| `SQUARE_SANDBOX_APPLICATION_ID` | Sandbox Application ID. |
| `SQUARE_SANDBOX_LOCATION_ID` | Sandbox location payments are taken under. |
| `SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY` | Sandbox webhook subscription's signature key. Optional. |

Sandbox and production credentials are held separately, so both can be set at
once and the environment picker swaps between them without anything being
retyped.

**Which environment is live is a setting, not an environment variable.** It is
chosen on the settings tab and stored in `sqp_settings.environment`, so it takes
effect on the next request rather than the next deployment. `SQUARE_ENVIRONMENT`
is still read as the fallback for an installation that has never picked one, so
an older site keeps whatever it was set to.

**Where the card is typed is a setting too**, on the same tab, stored in
`sqp_settings.card_entry`. It defaults to `hosted`, and it has to: on-page entry
needs an Application ID nobody has previously been asked for, so any other
default would switch a live shop's card payments off the moment it updated.
Switch it to *On your own checkout* once the Application ID is in.

Square's app **Credentials** page gives you both the Application ID and the
access token. The location ID is kept on a different page again, so the settings
tab has a **Look up locations** button that lists what the token can see and
fills the field in.

### Content-Security-Policy

On-page card entry loads Square's SDK, and the site's policy has to allow it.
Nothing to configure: the module declares the origins it needs in its manifest's
`cspOrigins`, and core unions them into the site's policy for as long as the
module is installed.

Square's own error-reporting endpoint is deliberately **not** among them. It is
not needed to take a payment, and quietly authorising a third-party telemetry
host on somebody's checkout is the owner's call to make, not a module's. The
cost is a console warning the shopper never sees.

Then turn the method on under **Shop → Payments → Square** and add a webhook
subscription in the Square developer dashboard (subscribed to the
`payment.created` and `payment.updated` events) pointing at:

```
https://<your-site>/api/m/square-payment-for-shop/webhook
```

The webhook URL must match exactly - Square's signature scheme covers the URL
as well as the payload, so a mismatch fails verification. Square issues the
signature key once the subscription exists; paste it back into the settings tab.

The signature key is optional. Without it the payment method still works and
payments are confirmed when the shopper is redirected back from Square - the
webhook is the backstop for a shopper who pays and then closes the tab, so a
live site should have one. The access token and location ID for the chosen
environment are what actually gate the method at checkout - plus the Application
ID, when the card is being typed on your own checkout.
