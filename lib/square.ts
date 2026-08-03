// Thin Square REST client. No SDK dependency - the handful of Payment Links /
// Orders / Payments / Refunds calls this module needs are plain REST.
// API reference: https://developer.squareup.com/reference/square
import { getSquareAccessToken, getSquareApiBase, getSquareLocationId } from '@/modules/square-payment-for-shop/lib/env'

const SQUARE_VERSION = '2024-01-18'

type SqFetchInit = { method?: string; body?: unknown }

async function sqFetch<T>(path: string, init: SqFetchInit = {}): Promise<T> {
  const token = getSquareAccessToken()
  if (!token) throw new Error('Square is not configured')

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Square-Version': SQUARE_VERSION,
    Accept: 'application/json',
  }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'

  const res = await fetch(`${getSquareApiBase()}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })

  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { errors?: Array<{ detail?: string; code?: string }> } | null
    const first = detail?.errors?.[0]
    throw new Error(first?.detail ?? first?.code ?? `Square API error ${res.status}`)
  }
  return (await res.json()) as T
}

// --- Payment links (the hosted checkout page) -----------------------------

export type SqPaymentLink = { id: string; url: string; squareOrderId: string }

// Creates a Square-hosted checkout page for a single charge. Square creates an
// order behind the link; its id is how the webhook's payment is matched back to
// our row. Idempotency keys stop a retried POST creating a duplicate link.
export async function createPaymentLink(input: {
  amount: number // minor units (pence)
  currency: string
  description: string
  referenceId: string
  redirectUrl: string
  idempotencyKey: string
}): Promise<SqPaymentLink> {
  const data = await sqFetch<{ payment_link: { id: string; url: string; order_id: string } }>(
    '/v2/online-checkout/payment-links',
    {
      method: 'POST',
      body: {
        idempotency_key: input.idempotencyKey,
        order: {
          location_id: getSquareLocationId(),
          reference_id: input.referenceId,
          line_items: [
            {
              name: input.description,
              quantity: '1',
              base_price_money: { amount: input.amount, currency: input.currency },
            },
          ],
        },
        checkout_options: { redirect_url: input.redirectUrl },
      },
    }
  )
  const link = data.payment_link
  return { id: link.id, url: link.url, squareOrderId: link.order_id }
}

// --- Orders ---------------------------------------------------------------

// The Square order behind a payment link. Once the shopper pays, the payment is
// linked as a tender; before that there is nothing to settle.
export type SqOrder = { id: string; paymentId: string | null }

export async function getOrder(id: string): Promise<SqOrder> {
  const data = await sqFetch<{ order: { id: string; tenders?: Array<{ id: string; payment_id?: string }> } }>(
    `/v2/orders/${encodeURIComponent(id)}`
  )
  const tender = data.order.tenders?.[0]
  // For payments taken through the Payments API the tender id IS the payment id;
  // payment_id is preferred where Square supplies it explicitly.
  return { id: data.order.id, paymentId: tender ? (tender.payment_id ?? tender.id) : null }
}

// --- Payments -------------------------------------------------------------

export type SqPayment = {
  id: string
  status: string // APPROVED | PENDING | COMPLETED | CANCELED | FAILED
  amount: number // minor units (pence)
  currency: string
  amountRefunded: number // minor units (pence)
  squareOrderId: string | null
}

// The money has actually been captured once a payment is COMPLETED. APPROVED is
// authorised-only (Square's hosted checkout captures automatically, so it is a
// transient state on the way to COMPLETED, not a terminal one).
export function isPaymentCollected(status: string): boolean {
  return status === 'COMPLETED'
}

export function isPaymentFailed(status: string): boolean {
  return status === 'FAILED' || status === 'CANCELED'
}

type SqRawPayment = {
  id: string
  status: string
  amount_money: { amount: number; currency: string }
  refunded_money?: { amount: number }
  order_id?: string
}

export function mapPayment(p: SqRawPayment): SqPayment {
  return {
    id: p.id,
    status: p.status,
    amount: p.amount_money.amount,
    currency: p.amount_money.currency,
    amountRefunded: p.refunded_money?.amount ?? 0,
    squareOrderId: p.order_id ?? null,
  }
}

export async function getPayment(id: string): Promise<SqPayment> {
  const data = await sqFetch<{ payment: SqRawPayment }>(`/v2/payments/${encodeURIComponent(id)}`)
  return mapPayment(data.payment)
}

// Cheap authenticated call used to check the access token works, points at the
// expected environment, and that the location id is real. Throws on failure.
export async function verifyCredentials(): Promise<void> {
  const locationId = getSquareLocationId()
  if (!locationId) throw new Error('Square location id is not set')
  await sqFetch(`/v2/locations/${encodeURIComponent(locationId)}`)
}

// --- Refunds --------------------------------------------------------------

export async function createRefund(input: {
  paymentId: string
  amount: number // minor units (pence)
  currency: string
  idempotencyKey: string
}): Promise<{ id: string }> {
  const data = await sqFetch<{ refund: { id: string } }>('/v2/refunds', {
    method: 'POST',
    body: {
      idempotency_key: input.idempotencyKey,
      payment_id: input.paymentId,
      amount_money: { amount: input.amount, currency: input.currency },
    },
  })
  return { id: data.refund.id }
}

export async function getRefund(id: string): Promise<{ id: string; status: string }> {
  const data = await sqFetch<{ refund: { id: string; status: string } }>(
    `/v2/refunds/${encodeURIComponent(id)}`
  )
  return { id: data.refund.id, status: data.refund.status }
}
