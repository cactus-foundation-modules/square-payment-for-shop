// GET /api/m/square-payment-for-shop/admin/status
// Reports whether the credentials for the live environment are set and whether
// Square accepts them. The webhook signature key is reported separately: it is
// recommended but does not gate the payment method.
import { NextResponse } from 'next/server'
import { requireShopUser } from '@/modules/shop/lib/access'
import { isSquareConfigured, isSquareWebhookConfigured } from '@/modules/square-payment-for-shop/lib/env'
import { getSquareEnvironment } from '@/modules/square-payment-for-shop/lib/settings'
import { verifyCredentials } from '@/modules/square-payment-for-shop/lib/square'

export async function GET() {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const environment = await getSquareEnvironment()
  const webhookConfigured = isSquareWebhookConfigured(environment)

  if (!isSquareConfigured(environment)) {
    return NextResponse.json({ configured: false, environment, webhookConfigured })
  }

  try {
    await verifyCredentials()
    return NextResponse.json({ configured: true, connected: true, environment, webhookConfigured })
  } catch (err) {
    return NextResponse.json({
      configured: true,
      connected: false,
      environment,
      webhookConfigured,
      error: err instanceof Error ? err.message : 'Connection failed',
    })
  }
}
