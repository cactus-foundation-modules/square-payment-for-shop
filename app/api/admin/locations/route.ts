// POST /api/m/square-payment-for-shop/admin/locations
// Lists the Square locations an access token can see, so the settings tab can
// offer a picker instead of asking for a location id typed out by hand.
//
// The token is taken from the request body when supplied: env vars are written
// to the hosting project and are not readable by the running server until the
// next deployment, so a just-typed token could not otherwise be used to look
// anything up. Falls back to the stored credentials for the environment asked
// about. Admin-gated like every other route in this module.
import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { requireShopUser } from '@/modules/shop/lib/access'
import { getSquareCredentials } from '@/modules/square-payment-for-shop/lib/env'
import { listLocations } from '@/modules/square-payment-for-shop/lib/square'

const Body = z.object({
  environment: z.enum(['sandbox', 'production']),
  accessToken: z.string().max(500).optional(),
})

export async function POST(request: NextRequest) {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const parsed = Body.safeParse(await request.json().catch(() => null))
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? 'Invalid request' }, { status: 400 })
  }

  const { environment } = parsed.data
  const accessToken = parsed.data.accessToken?.trim() || getSquareCredentials(environment).accessToken
  if (!accessToken) {
    return NextResponse.json({ error: 'Enter an access token first, then look up locations.' }, { status: 400 })
  }

  try {
    const locations = await listLocations({ accessToken, environment })
    return NextResponse.json({ locations })
  } catch (err) {
    // Nearly always a token from the other environment, or one without the
    // MERCHANT_PROFILE_READ permission. Pass Square's own wording through.
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Could not reach Square' },
      { status: 502 }
    )
  }
}
