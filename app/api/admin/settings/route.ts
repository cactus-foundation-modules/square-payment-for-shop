// GET/PATCH /api/m/square-payment-for-shop/admin/settings
// Non-secret module settings: the on/off toggle, the payment description, which
// Square environment the shop is taking payments in, and where the shopper types
// their card.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { getSquareSettings, updateSquareSettings } from '@/modules/square-payment-for-shop/lib/settings'

export async function GET() {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error
  return NextResponse.json(await getSquareSettings())
}

const PatchBody = z.object({
  enabled: z.boolean().optional(),
  paymentDescription: z.string().max(100).optional(),
  // Stored rather than an env var, so switching between test and live takes
  // effect on the next request instead of the next deployment.
  environment: z.enum(['sandbox', 'production']).optional(),
  // Stored for the same reason as the environment: a mode the owner can change
  // and see take effect, rather than one that waits for the next deployment.
  cardEntry: z.enum(['hosted', 'on-page']).optional(),
})

export async function PATCH(request: NextRequest) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const parsed = PatchBody.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid settings' }, { status: 400 })

  const settings = await updateSquareSettings(parsed.data)
  return NextResponse.json(settings)
}
