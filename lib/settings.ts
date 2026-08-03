import { prisma } from '@/lib/db/prisma'

export type SquareSettings = {
  enabled: boolean
  paymentDescription: string
}

const FALLBACK: SquareSettings = { enabled: false, paymentDescription: '' }

export async function getSquareSettings(): Promise<SquareSettings> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "sqp_settings" WHERE "id" = 'singleton' LIMIT 1
  `
  const r = rows[0]
  if (!r) return FALLBACK
  return {
    enabled: r.enabled as boolean,
    paymentDescription: (r.payment_description as string | null) ?? '',
  }
}

export async function updateSquareSettings(input: Partial<SquareSettings>): Promise<SquareSettings> {
  const current = await getSquareSettings()
  const merged = { ...current, ...input }
  await prisma.$executeRaw`
    INSERT INTO "sqp_settings" ("id", "enabled", "payment_description", "updated_at")
    VALUES ('singleton', ${merged.enabled}, ${merged.paymentDescription}, CURRENT_TIMESTAMP)
    ON CONFLICT ("id") DO UPDATE SET
      "enabled" = ${merged.enabled},
      "payment_description" = ${merged.paymentDescription},
      "updated_at" = CURRENT_TIMESTAMP
  `
  return getSquareSettings()
}
