// Square credentials, sourced from env vars (managed on the core admin settings
// page, like the Stripe/PayPal keys in shop). Nothing secret is stored in the
// database.
//
// Sandbox and production credentials live in SEPARATE variables so both sets
// can be held at once and the environment choice actually swaps which set is
// live. Sharing one set meant a saved production token still read as "set"
// while the panel was showing sandbox, and switching environment silently
// pointed production credentials at the sandbox API (or the reverse).
//
// WHICH environment is live is deliberately not here: it is a stored setting
// (see lib/settings.ts) so it can be changed without a deployment. Every
// function below therefore takes the environment as an argument - there is no
// ambient "current" one to get wrong, and a token can never be paired with the
// other environment's API base.
import type { SquareEnvironment } from '@/modules/square-payment-for-shop/lib/settings'

export type { SquareEnvironment }

export type SquareCredentialSet = {
  accessToken: string | null
  locationId: string | null
  webhookSignatureKey: string | null
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
export function getSquareCredentials(environment: SquareEnvironment): SquareCredentialSet {
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

// The access token and the location are what a payment link is created from, so
// those two are all the method needs before it can be offered at checkout.
//
// The webhook signature key is deliberately NOT part of this. Square only
// issues one once the webhook subscription exists, so requiring it up front
// made the method impossible to switch on. Without it the payment still
// confirms when the shopper is redirected back from Square - the webhook is the
// backstop for the shopper who closes the tab on Square's page.
export function isSquareConfigured(environment: SquareEnvironment): boolean {
  const creds = getSquareCredentials(environment)
  return !!(creds.accessToken && creds.locationId)
}

export function isSquareWebhookConfigured(environment: SquareEnvironment): boolean {
  return !!getSquareCredentials(environment).webhookSignatureKey
}

export function getSquareApiBase(environment: SquareEnvironment): string {
  return environment === 'production'
    ? 'https://connect.squareup.com'
    : 'https://connect.squareupsandbox.com'
}
