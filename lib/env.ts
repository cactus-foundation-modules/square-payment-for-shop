// Credentials and environment for Square, sourced from env vars (managed on
// the core admin settings page, like the Stripe/PayPal keys in shop). Nothing
// secret is stored in the database.
//
// Sandbox and production credentials live in SEPARATE variables so both sets
// can be held at once and the environment choice actually swaps which set is
// live. Sharing one set meant a saved production token still read as "set"
// while the panel was showing sandbox, and switching environment silently
// pointed production credentials at the sandbox API (or the reverse).

export type SquareEnvironment = 'production' | 'sandbox'

export function getSquareEnvironment(): SquareEnvironment {
  return process.env.SQUARE_ENVIRONMENT === 'production' ? 'production' : 'sandbox'
}

// Production keeps the original unprefixed names; sandbox gets its own set.
// Exported so the settings tab writes to exactly the names read back here.
export function squareEnvVarNames(environment: SquareEnvironment) {
  return environment === 'sandbox'
    ? {
        accessToken: 'SQUARE_SANDBOX_ACCESS_TOKEN',
        locationId: 'SQUARE_SANDBOX_LOCATION_ID',
        webhookSignatureKey: 'SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY',
      }
    : {
        accessToken: 'SQUARE_ACCESS_TOKEN',
        locationId: 'SQUARE_LOCATION_ID',
        webhookSignatureKey: 'SQUARE_WEBHOOK_SIGNATURE_KEY',
      }
}

// Static process.env references on purpose - a computed `process.env[name]`
// lookup is not inlined by the bundler and reads as empty in some runtimes.
export function getSquareCredentials(environment: SquareEnvironment = getSquareEnvironment()): {
  accessToken: string | null
  locationId: string | null
  webhookSignatureKey: string | null
} {
  return environment === 'sandbox'
    ? {
        accessToken: process.env.SQUARE_SANDBOX_ACCESS_TOKEN || null,
        locationId: process.env.SQUARE_SANDBOX_LOCATION_ID || null,
        webhookSignatureKey: process.env.SQUARE_SANDBOX_WEBHOOK_SIGNATURE_KEY || null,
      }
    : {
        accessToken: process.env.SQUARE_ACCESS_TOKEN || null,
        locationId: process.env.SQUARE_LOCATION_ID || null,
        webhookSignatureKey: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || null,
      }
}

export function getSquareAccessToken(): string | null {
  return getSquareCredentials().accessToken
}

export function getSquareLocationId(): string | null {
  return getSquareCredentials().locationId
}

export function getSquareWebhookSignatureKey(): string | null {
  return getSquareCredentials().webhookSignatureKey
}

// The access token and the location are what a payment link is created from, so
// those two are all the method needs before it can be offered at checkout.
//
// The webhook signature key is deliberately NOT part of this. Square only
// issues one once the webhook subscription exists, so requiring it up front
// made the method impossible to switch on. Without it the payment still
// confirms when the shopper is redirected back from Square - the webhook is the
// backstop for the shopper who closes the tab on Square's page.
export function isSquareConfigured(): boolean {
  const creds = getSquareCredentials()
  return !!(creds.accessToken && creds.locationId)
}

export function isSquareWebhookConfigured(): boolean {
  return !!getSquareWebhookSignatureKey()
}

export function getSquareApiBase(environment: SquareEnvironment = getSquareEnvironment()): string {
  return environment === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com'
}
