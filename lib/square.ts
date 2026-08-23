// Thin Square REST client. No SDK dependency - the handful of Payment Links /
// Orders / Payments / Refunds calls this module needs are plain REST.
// API reference: https://developer.squareup.com/reference/square
import { getSquareApiBase, getSquareCredentials, type SquareEnvironment } from '@/modules/square-payment-for-shop/lib/env'
import { getSquareEnvironment } from '@/modules/square-payment-for-shop/lib/settings'

const SQUARE_VERSION = '2024-01-18'

/** A Square API refusal, carrying the machine-readable parts of it.
 *
 *  `message` stays Square's `detail` so every existing caller (the locations
 *  lookup, the connection check) reads exactly as it did. What is new is `code`
 *  and `category`, because `detail` is NOT written for a shopper: a card with no
 *  money on it comes back as "Authorization error:
 *  'CARDHOLDER_INSUFFICIENT_PERMISSIONS'", which tells the person holding it
 *  nothing at all and looks like the site is broken. See lib/decline.ts. */
export class SquareApiError extends Error {
  readonly code: string | null
  readonly category: string | null
  readonly status: number

  constructor(input: { message: string; code?: string | null; category?: string | null; status: number }) {
    super(input.message)
    this.name = 'SquareApiError'
    this.code = input.code ?? null
    this.category = input.category ?? null
    this.status = input.status
  }
}

// Credentials supplied by the caller instead of read from the environment. The
// settings tab uses this to look up locations for a token that has only just
// been typed in - env vars are not readable until the next deployment, so
// without it the location picker would be useless exactly when it is needed.
export type SquareCredentials = { accessToken: string; environment: SquareEnvironment }

type SqFetchInit = { method?: string; body?: unknown; creds?: SquareCredentials }

// The token and the API base are always taken from the same environment, in one
// place. Resolving them separately is how a sandbox token ends up being sent to
// the production API, which Square answers with an authentication error that
// says nothing at all about the real cause.
async function resolveCredentials(): Promise<SquareCredentials & { locationId: string | null }> {
  const environment = await getSquareEnvironment()
  const { accessToken, locationId } = getSquareCredentials(environment)
  if (!accessToken) throw new Error('Square is not configured')
  return { accessToken, environment, locationId }
}

async function sqFetch<T>(path: string, init: SqFetchInit = {}): Promise<T> {
  const creds = init.creds ?? (await resolveCredentials())
  const token = creds.accessToken

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    'Square-Version': SQUARE_VERSION,
    Accept: 'application/json',
  }
  if (init.body !== undefined) headers['Content-Type'] = 'application/json'

  const base = getSquareApiBase(creds.environment)
  const res = await fetch(`${base}${path}`, {
    method: init.method ?? 'GET',
    headers,
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(20_000),
  })

  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as
      { errors?: Array<{ detail?: string; code?: string; category?: string }> } | null
    const first = body?.errors?.[0]
    throw new SquareApiError({
      message: first?.detail ?? first?.code ?? `Square API error ${res.status}`,
      code: first?.code ?? null,
      category: first?.category ?? null,
      status: res.status,
    })
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
  // Resolved once and passed down, so the location and the token that authorises
  // it are guaranteed to belong to the same Square environment.
  const creds = await resolveCredentials()
  if (!creds.locationId) throw new Error('Square location id is not set')

  const data = await sqFetch<{ payment_link: { id: string; url: string; order_id: string } }>(
    '/v2/online-checkout/payment-links',
    {
      creds,
      method: 'POST',
      body: {
        idempotency_key: input.idempotencyKey,
        order: {
          location_id: creds.locationId,
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

// Creates a bare Square order for a single charge, with no hosted page attached.
// Used by on-page card entry, where there is no payment link to create one as a
// side effect.
//
// Made up front, before the shopper has typed a card, for one reason: the
// webhook matches a payment back to our row by the Square order id, and that
// only works if our row already knows it. Creating the order at payment time
// instead would leave a window in which Square's own `payment.created` arrives
// naming an order we have never heard of, and the webhook answers 200 to
// anything it cannot place - so Square would never retry it.
export async function createOrder(input: {
  amount: number // minor units (pence)
  currency: string
  description: string
  referenceId: string
  idempotencyKey: string
}): Promise<{ id: string }> {
  const creds = await resolveCredentials()
  if (!creds.locationId) throw new Error('Square location id is not set')

  const data = await sqFetch<{ order: { id: string } }>('/v2/orders', {
    creds,
    method: 'POST',
    body: {
      idempotency_key: input.idempotencyKey,
      order: {
        location_id: creds.locationId,
        reference_id: input.referenceId,
        line_items: [
          {
            name: input.description,
            quantity: '1',
            base_price_money: { amount: input.amount, currency: input.currency },
          },
        ],
      },
    },
  })
  return { id: data.order.id }
}

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

// Charges a card token produced by the browser's Web Payments SDK. On-page card
// entry only - the hosted checkout page charges the card itself.
//
// `verificationToken` is the result of the SDK's verifyBuyer() call, and it is
// what carries Strong Customer Authentication - a UK or EEA card charged without
// one is liable to be declined by the issuing bank for no reason the shopper can
// see. Optional all the same, because there are cards and regions for which that
// call has nothing to hand back, and omitting the field entirely is not the same
// as sending an empty one: Square rejects the latter outright.
//
// `orderId` ties the payment to the Square order made at intent time, which is
// how the webhook finds its way back to our row. Square rejects a payment whose
// amount disagrees with that order's total, which makes it a second check on
// the figures for free.
export async function createPayment(input: {
  sourceId: string
  verificationToken?: string
  amount: number // minor units (pence)
  currency: string
  orderId: string
  referenceId: string
  buyerEmail: string
  idempotencyKey: string
}): Promise<SqPayment> {
  const creds = await resolveCredentials()
  if (!creds.locationId) throw new Error('Square location id is not set')

  const data = await sqFetch<{ payment: SqRawPayment }>('/v2/payments', {
    creds,
    method: 'POST',
    body: {
      idempotency_key: input.idempotencyKey,
      source_id: input.sourceId,
      ...(input.verificationToken ? { verification_token: input.verificationToken } : {}),
      location_id: creds.locationId,
      order_id: input.orderId,
      reference_id: input.referenceId,
      buyer_email_address: input.buyerEmail,
      amount_money: { amount: input.amount, currency: input.currency },
      // Capture straight away rather than authorise and capture later. The shop
      // has no second step at which somebody decides to take the money, so an
      // authorisation left uncaptured would simply expire.
      autocomplete: true,
    },
  })
  return mapPayment(data.payment)
}

// Cheap authenticated call used to check the access token works, points at the
// expected environment, and that the location id is real. Throws on failure.
export async function verifyCredentials(): Promise<void> {
  const creds = await resolveCredentials()
  if (!creds.locationId) throw new Error('Square location id is not set')
  await sqFetch(`/v2/locations/${encodeURIComponent(creds.locationId)}`, { creds })
}

// --- Locations ------------------------------------------------------------

export type SqLocation = { id: string; name: string; status: string; currency: string | null }

// Square's app credentials page hands out an Application ID and an access
// token; the location id lives on a different page again. Rather than send the
// admin hunting for it, the settings tab lists what the token can see and lets
// them pick.
export async function listLocations(creds?: SquareCredentials): Promise<SqLocation[]> {
  const data = await sqFetch<{
    locations?: Array<{ id: string; name?: string; status?: string; currency?: string }>
  }>('/v2/locations', { creds })
  return (data.locations ?? []).map((l) => ({
    id: l.id,
    name: l.name?.trim() || l.id,
    status: l.status ?? 'UNKNOWN',
    currency: l.currency ?? null,
  }))
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
