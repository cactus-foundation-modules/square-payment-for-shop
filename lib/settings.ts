// This module's own settings: the on/off toggle, the payment description, and
// which of the two Square environments the shop takes payments in.
//
// The environment lives here rather than in SQUARE_ENVIRONMENT because an
// environment variable on a hosted project does not reach the running server
// until the next deployment. Choosing "Production" therefore did nothing until
// a redeploy, and the settings panel - reading back the environment the server
// could actually see - snapped the dropdown straight back to Sandbox, which
// looked for all the world like the save had failed. A stored setting takes
// effect on the very next request.
//
// The credentials themselves stay in environment variables, because they are
// secrets and the database is included in backups.
import { prisma } from '@/lib/db/prisma'

export type SquareEnvironment = 'production' | 'sandbox'

// Where the shopper types their card.
//
//  'hosted'  - Square's own checkout page. The shopper is sent to squareup.com
//              and redirected back. What this module did before there was a
//              choice, and still the right answer for a shop that would rather
//              not think about Application IDs.
//
//  'on-page' - Square's card fields, drawn on this site's own checkout. The
//              fields are Square's own frames, so the card number still never
//              touches this site, but the shopper never leaves the checkout -
//              which is where most of the people who abandon a hosted page go.
//              Needs the Square Application ID as well as the access token.
export type SquareCardEntry = 'hosted' | 'on-page'

export type SquareSettings = {
  enabled: boolean
  paymentDescription: string
  environment: SquareEnvironment
  cardEntry: SquareCardEntry
  // Whether the Apple Pay and Google Pay buttons are drawn above "Place order".
  // Only ever honoured alongside on-page card entry: the hosted page carries
  // Square's own wallet buttons already, and drawing a second pair on the way
  // to it would be two ways of doing one thing.
  walletsEnabled: boolean
  // The contents of Apple's domain-association file, pasted in by the owner
  // from Square's developer dashboard. Served at the fixed path Apple demands
  // via core's .well-known route (see lib/well-known.ts). Blank until the owner
  // has been through Apple's registration - and while it is blank the Apple Pay
  // button is not offered, because Apple would refuse it anyway.
  applePayDomainAssociation: string
}

// The fallback for a site that has never picked an environment on the settings
// panel: whatever SQUARE_ENVIRONMENT says, which keeps a site that had already
// set that variable on the environment it was using. Sandbox is the safe
// default for anything else - a misconfigured site should fail to take real
// money rather than take it by accident.
export function environmentFromEnvVar(): SquareEnvironment {
  return process.env.SQUARE_ENVIRONMENT === 'production' ? 'production' : 'sandbox'
}

function toEnvironment(stored: unknown): SquareEnvironment {
  return stored === 'production' || stored === 'sandbox' ? stored : environmentFromEnvVar()
}

// Anything unrecognised reads as 'hosted' - the mode that needs no extra
// credentials and therefore cannot be the wrong guess for a shop that has never
// chosen. See the column comment in migrations/003_card_entry.sql.
function toCardEntry(stored: unknown): SquareCardEntry {
  return stored === 'on-page' ? 'on-page' : 'hosted'
}

const FALLBACK: SquareSettings = {
  enabled: false,
  paymentDescription: '',
  environment: 'sandbox',
  cardEntry: 'hosted',
  walletsEnabled: false,
  applePayDomainAssociation: '',
}

export async function getSquareSettings(): Promise<SquareSettings> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "sqp_settings" WHERE "id" = 'singleton' LIMIT 1
  `
  const r = rows[0]
  if (!r) return { ...FALLBACK, environment: environmentFromEnvVar() }
  return {
    enabled: r.enabled as boolean,
    paymentDescription: (r.payment_description as string | null) ?? '',
    environment: toEnvironment(r.environment),
    cardEntry: toCardEntry(r.card_entry),
    // Coalesced rather than cast: this reads a row that may predate
    // migrations/004 by a deploy or two, and `undefined as boolean` is how a
    // shop ends up with a wallet button it never asked for.
    walletsEnabled: r.wallets_enabled === true,
    applePayDomainAssociation: (r.apple_pay_domain_association as string | null) ?? '',
  }
}

// Convenience for the code paths that only care which environment is live.
export async function getSquareEnvironment(): Promise<SquareEnvironment> {
  return (await getSquareSettings()).environment
}

export async function updateSquareSettings(input: Partial<SquareSettings>): Promise<SquareSettings> {
  const current = await getSquareSettings()
  const merged = { ...current, ...input }
  await prisma.$executeRaw`
    INSERT INTO "sqp_settings" ("id", "enabled", "payment_description", "environment", "card_entry", "wallets_enabled", "apple_pay_domain_association", "updated_at")
    VALUES ('singleton', ${merged.enabled}, ${merged.paymentDescription}, ${merged.environment}, ${merged.cardEntry}, ${merged.walletsEnabled}, ${merged.applePayDomainAssociation}, CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO UPDATE SET
      "enabled" = ${merged.enabled},
      "payment_description" = ${merged.paymentDescription},
      "environment" = ${merged.environment},
      "card_entry" = ${merged.cardEntry},
      "wallets_enabled" = ${merged.walletsEnabled},
      "apple_pay_domain_association" = ${merged.applePayDomainAssociation},
      "updated_at" = CURRENT_TIMESTAMP
  `
  return getSquareSettings()
}
