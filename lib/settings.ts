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

export type SquareSettings = {
  enabled: boolean
  paymentDescription: string
  environment: SquareEnvironment
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

const FALLBACK: SquareSettings = {
  enabled: false,
  paymentDescription: '',
  environment: 'sandbox',
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
    INSERT INTO "sqp_settings" ("id", "enabled", "payment_description", "environment", "updated_at")
    VALUES ('singleton', ${merged.enabled}, ${merged.paymentDescription}, ${merged.environment}, CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO UPDATE SET
      "enabled" = ${merged.enabled},
      "payment_description" = ${merged.paymentDescription},
      "environment" = ${merged.environment},
      "updated_at" = CURRENT_TIMESTAMP
  `
  return getSquareSettings()
}
