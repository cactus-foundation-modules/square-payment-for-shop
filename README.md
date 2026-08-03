# Square Payments for Shop

Adds **card payment via Square** as a checkout payment method in the Cactus
Shop. The shopper is sent to Square's hosted checkout page to enter their card,
so no card data ever touches the site - which also keeps PCI scope to the
lightest tier.

Built on Square's [Payment Links API](https://developer.squareup.com/docs/checkout-api/payment-links)
(hosted checkout), with the [Payments](https://developer.squareup.com/reference/square/payments-api)
and [Refunds](https://developer.squareup.com/reference/square/refunds-api) APIs
behind it.

- **Table prefix:** `sqp_`
- **Depends on:** the `shop` module (`>= 0.1.90`, which exposes the
  `shop.payment-providers` extension point)

## How it works

1. At checkout the shopper picks *Card payment (Square)*. The module creates a
   Square payment link for the order total and redirects the shopper to
   Square's hosted checkout page to pay by card.
2. On return, and via Square webhooks, the order is confirmed: it stays at
   *Awaiting confirmation* until the payment completes, then flips to *Paid*
   and the usual order fulfilment (email, stock, downloads) runs.
3. Refunds are issued from the order screen like any other provider.

## Configuration

Set these environment variables (managed on **Shop → Payments → Square** in
the admin, or in `.env.local` for local development):

| Variable | Purpose |
|----------|---------|
| `SQUARE_ENVIRONMENT` | `sandbox` (default) or `production`. Picks which credential set below is used. |
| `SQUARE_ACCESS_TOKEN` | Production API access token. |
| `SQUARE_LOCATION_ID` | Production location payments are taken under. |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | Production webhook subscription's signature key. Optional. |
| `SQUARE_SANDBOX_ACCESS_TOKEN` | Sandbox API access token. |
| `SQUARE_SANDBOX_LOCATION_ID` | Sandbox location payments are taken under. |
| `SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY` | Sandbox webhook subscription's signature key. Optional. |

Sandbox and production credentials are held separately, so both can be set at
once and `SQUARE_ENVIRONMENT` swaps between them without anything being
retyped.

Square's app **Credentials** page gives you an Application ID and an access
token; only the access token is needed here (the Application ID is for the Web
Payments SDK and OAuth, neither of which this module uses). The location ID is
kept on a different page again, so the settings tab has a **Look up locations**
button that lists what the token can see and fills the field in.

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
environment are what actually gate the method at checkout.
