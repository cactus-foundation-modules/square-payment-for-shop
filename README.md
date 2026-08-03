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
| `SQUARE_ACCESS_TOKEN` | Your Square API access token. |
| `SQUARE_LOCATION_ID` | The Square location payments are taken under. |
| `SQUARE_WEBHOOK_SIGNATURE_KEY` | The signature key for the webhook subscription you add in the Square developer dashboard. |
| `SQUARE_ENVIRONMENT` | `sandbox` (default) or `production`. |

Then turn the method on under **Shop → Payments → Square** and add a webhook
subscription in the Square developer dashboard (subscribed to the
`payment.created` and `payment.updated` events) pointing at:

```
https://<your-site>/api/m/square-payment-for-shop/webhook
```

The webhook URL must match exactly - Square's signature scheme covers the URL
as well as the payload, so a mismatch fails verification.

Sandbox and production use different access tokens, location IDs and signature
keys, so switching `SQUARE_ENVIRONMENT` means updating all three to match.
