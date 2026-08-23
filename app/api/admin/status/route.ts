// GET /api/m/square-payment-for-shop/admin/status
// Reports whether the credentials for the live environment are set and whether
// Square accepts them. The webhook signature key is reported separately: it is
// recommended but does not gate the payment method. So is the Application ID,
// which only on-page card entry needs - but there it DOES gate the method, so
// the panel is told about it either way.
import { NextResponse } from 'next/server'
import { requireShopUser } from '@/modules/shop/lib/access'
import { getSquareCredentials, isSquareConfigured, isSquareWebhookConfigured } from '@/modules/square-payment-for-shop/lib/env'
import { getSquareSettings } from '@/modules/square-payment-for-shop/lib/settings'
import { verifyCredentials } from '@/modules/square-payment-for-shop/lib/square'

export async function GET() {
  const gate = await requireShopUser('shop.manage')
  if (gate.error) return gate.error

  const { environment, cardEntry } = await getSquareSettings()
  const webhookConfigured = isSquareWebhookConfigured(environment)
  const creds = getSquareCredentials(environment)
  // Reported one credential at a time rather than as a single "configured"
  // flag, so the panel can name what is actually missing. Telling an admin to
  // add three things when two of them are already in - and showing "(set)"
  // beside one of the three while saying it - is how a working setup reads as
  // a broken one.
  const base = {
    environment,
    cardEntry,
    webhookConfigured,
    accessTokenSet: !!creds.accessToken,
    locationIdSet: !!creds.locationId,
    applicationIdSet: !!creds.applicationId,
  }

  if (!isSquareConfigured(environment, cardEntry)) {
    return NextResponse.json({ ...base, configured: false })
  }

  try {
    await verifyCredentials()
    return NextResponse.json({ ...base, configured: true, connected: true })
  } catch (err) {
    return NextResponse.json({
      ...base,
      configured: true,
      connected: false,
      error: err instanceof Error ? err.message : 'Connection failed',
    })
  }
}
