import { randomUUID } from 'crypto'
import { prisma } from '@/lib/db/prisma'

export type SqpPayment = {
  id: string
  orderId: string
  orderNumber: string
  paymentLinkId: string | null
  squareOrderId: string | null
  paymentId: string | null
  status: string
  amount: string
  currency: string
}

function mapRow(r: Record<string, unknown>): SqpPayment {
  return {
    id: r.id as string,
    orderId: r.order_id as string,
    orderNumber: r.order_number as string,
    paymentLinkId: (r.payment_link_id as string | null) ?? null,
    squareOrderId: (r.square_order_id as string | null) ?? null,
    paymentId: (r.payment_id as string | null) ?? null,
    status: r.status as string,
    amount: (r.amount as { toString(): string }).toString(),
    currency: r.currency as string,
  }
}

export async function createSqpPayment(input: {
  orderId: string
  orderNumber: string
  paymentLinkId: string
  squareOrderId: string
  amount: number
  currency: string
  status?: string
}): Promise<SqpPayment> {
  const id = randomUUID()
  await prisma.$executeRaw`
    INSERT INTO "sqp_payments" (
      "id", "order_id", "order_number", "payment_link_id", "square_order_id",
      "status", "amount", "currency", "created_at", "updated_at"
    ) VALUES (
      ${id}, ${input.orderId}, ${input.orderNumber}, ${input.paymentLinkId}, ${input.squareOrderId},
      ${input.status ?? 'PENDING'}, ${input.amount}, ${input.currency}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )
  `
  const row = await getSqpPaymentById(id)
  if (!row) throw new Error('Failed to create sqp_payments row')
  return row
}

export async function getSqpPaymentById(id: string): Promise<SqpPayment | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "sqp_payments" WHERE "id" = ${id} LIMIT 1
  `
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getSqpPaymentByOrderId(orderId: string): Promise<SqpPayment | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "sqp_payments" WHERE "order_id" = ${orderId} ORDER BY "created_at" DESC LIMIT 1
  `
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getSqpPaymentBySquareOrderId(squareOrderId: string): Promise<SqpPayment | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "sqp_payments" WHERE "square_order_id" = ${squareOrderId} LIMIT 1
  `
  return rows[0] ? mapRow(rows[0]) : null
}

export async function getSqpPaymentByPaymentId(paymentId: string): Promise<SqpPayment | null> {
  const rows = await prisma.$queryRaw<Record<string, unknown>[]>`
    SELECT * FROM "sqp_payments" WHERE "payment_id" = ${paymentId} LIMIT 1
  `
  return rows[0] ? mapRow(rows[0]) : null
}

export async function updateSqpPayment(id: string, patch: { paymentId?: string; status?: string }): Promise<void> {
  if (patch.paymentId !== undefined) {
    await prisma.$executeRaw`UPDATE "sqp_payments" SET "payment_id" = ${patch.paymentId}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${id}`
  }
  if (patch.status !== undefined) {
    await prisma.$executeRaw`UPDATE "sqp_payments" SET "status" = ${patch.status}, "updated_at" = CURRENT_TIMESTAMP WHERE "id" = ${id}`
  }
}
