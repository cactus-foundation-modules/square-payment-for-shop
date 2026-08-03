// GET/PATCH /api/m/square-payment-for-shop/admin/settings
// Non-secret module settings: the on/off toggle, the payment description, and
// which Square environment the shop is taking payments in.
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
})

export async function PATCH(request: NextRequest) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const parsed = PatchBody.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid settings' }, { status: 400 })

  const settings = await updateSquareSettings(parsed.data)
  return NextResponse.json(settings)
}
