// Credentials and environment for Square, sourced from env vars (managed on
// the core admin settings page, like the Stripe/PayPal keys in shop). Nothing
// secret is stored in the database.

export function getSquareAccessToken(): string | null {
  return process.env.SQUARE_ACCESS_TOKEN || null
}

export function getSquareLocationId(): string | null {
  return process.env.SQUARE_LOCATION_ID || null
}

export function getSquareWebhookSignatureKey(): string | null {
  return process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || null
}

// The access token and location (to create payment links) and the webhook
// signature key (to confirm payments settle) are all needed for the method to
// work end to end, so all must be present before it is offered at checkout.
export function isSquareConfigured(): boolean {
  return !!(getSquareAccessToken() && getSquareLocationId() && getSquareWebhookSignatureKey())
}

export function getSquareEnvironment(): 'production' | 'sandbox' {
  return process.env.SQUARE_ENVIRONMENT === 'production' ? 'production' : 'sandbox'
}

export function getSquareApiBase(): string {
  return getSquareEnvironment() === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com'
}
