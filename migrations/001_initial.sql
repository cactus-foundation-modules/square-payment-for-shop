-- Square Payments for Shop - initial schema (prefix sqp_).
-- All DDL idempotent so it is safe to re-run on every deploy.

-- Non-secret module settings (singleton). Credentials live in env vars
-- (SQUARE_ACCESS_TOKEN / SQUARE_LOCATION_ID / SQUARE_WEBHOOK_SIGNATURE_KEY),
-- never in the database. Which environment those credentials are used against
-- IS stored here - see 002 for why. NULL falls back to SQUARE_ENVIRONMENT.
CREATE TABLE IF NOT EXISTS "sqp_settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "payment_description" TEXT NOT NULL DEFAULT '',
    "environment" TEXT,
    "card_entry" TEXT NOT NULL DEFAULT 'hosted',
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sqp_settings_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "sqp_settings_singleton" CHECK ("id" = 'singleton'),
    CONSTRAINT "sqp_settings_environment_check" CHECK ("environment" IS NULL OR "environment" IN ('sandbox', 'production')),
    CONSTRAINT "sqp_settings_card_entry_check" CHECK ("card_entry" IN ('hosted', 'on-page'))
);
INSERT INTO "sqp_settings" ("id") VALUES ('singleton') ON CONFLICT ("id") DO NOTHING;

-- One row per checkout attempt: maps a shop order to its Square payment link
-- (hosted card entry only - nothing is linked to when the card is typed on this
-- site), the Square order behind it, and (once the shopper pays) the payment.
CREATE TABLE IF NOT EXISTS "sqp_payments" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "order_number" TEXT NOT NULL,
    "payment_link_id" TEXT,
    "square_order_id" TEXT,
    "payment_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "amount" NUMERIC(12, 2) NOT NULL,
    "currency" TEXT NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sqp_payments_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "sqp_payments_order_id_idx" ON "sqp_payments" ("order_id");
CREATE UNIQUE INDEX IF NOT EXISTS "sqp_payments_square_order_id_key" ON "sqp_payments" ("square_order_id");
CREATE INDEX IF NOT EXISTS "sqp_payments_payment_id_idx" ON "sqp_payments" ("payment_id");
