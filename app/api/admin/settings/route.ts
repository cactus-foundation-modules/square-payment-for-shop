// GET/PATCH /api/m/square-payment-for-shop/admin/settings
// Non-secret module settings (the on/off toggle and payment description).
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
})

export async function PATCH(request: NextRequest) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const parsed = PatchBody.safeParse(await request.json())
  if (!parsed.success) return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid settings' }, { status: 400 })

  const settings = await updateSquareSettings(parsed.data)
  return NextResponse.json(settings)
}
