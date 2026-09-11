-- Replaces the flat servesDirectly boolean with a 3-way serve mode: KITCHEN
-- (full ticket), COUNTER (no prep, but a human at a fixed counter still has
-- to confirm it — born at READY), DIRECT (served instantly, today's true).

CREATE TYPE "OrderServeMode" AS ENUM ('KITCHEN', 'COUNTER', 'DIRECT');

ALTER TABLE "Location" ADD COLUMN "serveMode" "OrderServeMode" NOT NULL DEFAULT 'KITCHEN';
UPDATE "Location" SET "serveMode" = 'DIRECT' WHERE "servesDirectly" = true;
ALTER TABLE "Location" DROP COLUMN "servesDirectly";
