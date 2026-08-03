-- Which of the two Square environments the shop uses moves out of the
-- SQUARE_ENVIRONMENT environment variable and into this module's own settings.
--
-- Environment variables on a hosted project only reach the running server on the
-- next deployment, so choosing "Production" did nothing until a redeploy - and
-- the settings panel, reading back what the server could actually see, snapped
-- the dropdown straight back to Sandbox. A stored setting takes effect on the
-- next request.
--
-- NULL means "never chosen here", which falls back to SQUARE_ENVIRONMENT so a
-- site that had already set that variable keeps the environment it was using.
ALTER TABLE "sqp_settings" ADD COLUMN IF NOT EXISTS "environment" TEXT;

ALTER TABLE "sqp_settings" DROP CONSTRAINT IF EXISTS "sqp_settings_environment_check";
ALTER TABLE "sqp_settings" ADD CONSTRAINT "sqp_settings_environment_check"
    CHECK ("environment" IS NULL OR "environment" IN ('sandbox', 'production'));
