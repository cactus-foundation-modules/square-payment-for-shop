// POST /api/m/square-payment-for-shop/webhook
// Square calls this when a payment is created or changes state.
// Signature-verified; no session (Square is the caller).
import { NextRequest, NextResponse } from 'next/server'
import { createHmac, timingSafeEqual } from 'crypto'
import { getSiteUrl } from '@/lib/config/env'
import { getSquareWebhookSignatureKey } from '@/modules/square-payment-for-shop/lib/env'
import * as sq from '@/modules/square-payment-for-shop/lib/square'
import { getSqpPaymentByPaymentId, getSqpPaymentBySquareOrderId } from '@/modules/square-payment-for-shop/lib/db'
import { settleFromPayment } from '@/modules/square-payment-for-shop/lib/settle'

const WEBHOOK_PATH = '/api/m/square-payment-for-shop/webhook'

// Square signs (notification URL + raw body) with HMAC-SHA256 using the
// subscription's signature key and sends it base64-encoded in the
// x-square-hmacsha256-signature header. The URL half means the webhook
// subscription in the Square dashboard must point at exactly the URL this route
// derives from the site URL - any mismatch fails verification.
function verifySignature(rawBody: string, signature: string, key: string): boolean {
  if (!signature) return false
  const notificationUrl = `${getSiteUrl()}${WEBHOOK_PATH}`
  const expected = createHmac('sha256', key).update(notificationUrl + rawBody, 'utf8').digest('base64')
  const a = Buffer.from(expected)
  const b = Buffer.from(signature)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

type SqWebhookEvent = {
  type?: string
  data?: {
    object?: {
      payment?: {
        id: string
        status: string
        amount_money: { amount: number; currency: string }
        refunded_money?: { amount: number }
        order_id?: string
      }
    }
  }
}

async function handleEvent(event: SqWebhookEvent): Promise<void> {
  if (event.type !== 'payment.created' && event.type !== 'payment.updated') return
  const rawPayment = event.data?.object?.payment
  if (!rawPayment) return

  // Resolve our row by the Square order behind the payment link (linked at
  // intent time), falling back to the payment id once a prior event or the
  // return route has linked it. Payments for anything else are ignored.
  const row =
    (rawPayment.order_id ? await getSqpPaymentBySquareOrderId(rawPayment.order_id) : null) ??
    (await getSqpPaymentByPaymentId(rawPayment.id))
  if (!row) return

  // Re-fetch from Square rather than trusting the webhook payload: the
  // signature proves the sender, but the API is the source of truth for status.
  const payment = await sq.getPayment(rawPayment.id)
  await settleFromPayment(row, payment)
}

export async function POST(request: NextRequest) {
  // No signature key means no way to tell Square's calls from anyone else's, so
  // nothing is accepted. The payment method still works without one - the
  // redirect-return route confirms the payment - this is just the backstop for
  // the shopper who never comes back.
  const key = getSquareWebhookSignatureKey()
  if (!key) return new NextResponse('Not configured', { status: 503 })

  const rawBody = await request.text()
  const signature = request.headers.get('x-square-hmacsha256-signature') ?? ''
  if (!verifySignature(rawBody, signature, key)) {
    return new NextResponse('Invalid signature', { status: 403 })
  }

  let parsed: SqWebhookEvent
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return new NextResponse('Invalid payload', { status: 400 })
  }

  try {
    await handleEvent(parsed)
  } catch (err) {
    // Settlement is idempotent, so let Square retry on failure.
    console.error('[square-payment] webhook event failed', err)
    return new NextResponse('Event handling failed', { status: 500 })
  }

  return NextResponse.json({ ok: true })
}
