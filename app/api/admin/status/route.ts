// GET /api/m/square-payment-for-shop/admin/status
// Reports whether the credentials are set and whether Square accepts them.
import { NextResponse } from 'next/server'
import { requireShopUser } from '@/modules/shop/lib/access'
import { isSquareConfigured, getSquareEnvironment } from '@/modules/square-payment-for-shop/lib/env'
import { verifyCredentials } from '@/modules/square-payment-for-shop/lib/square'

export async function GET() {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  if (!isSquareConfigured()) {
    return NextResponse.json({ configured: false, environment: getSquareEnvironment() })
  }

  try {
    await verifyCredentials()
    return NextResponse.json({ configured: true, connected: true, environment: getSquareEnvironment() })
  } catch (err) {
    return NextResponse.json({
      configured: true,
      connected: false,
      environment: getSquareEnvironment(),
      error: err instanceof Error ? err.message : 'Connection failed',
    })
  }
}
