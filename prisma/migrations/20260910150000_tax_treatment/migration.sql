-- Per-line tax treatment: Standard (rate + inclusive/exclusive), Zero-rated,
-- or Exempt. A menu item inherits the tenant default unless it overrides;
-- the resolved value is snapshotted onto each POS order line.

CREATE TYPE "TaxTreatment" AS ENUM ('STANDARD', 'ZERO_RATED', 'EXEMPT');

-- BusinessProfile: taxRate becomes NOT NULL with a 16% default; add treatment.
UPDATE "BusinessProfile" SET "taxRate" = 16 WHERE "taxRate" IS NULL;
ALTER TABLE "BusinessProfile"
  ALTER COLUMN "taxRate" SET DEFAULT 16,
  ALTER COLUMN "taxRate" SET NOT NULL;
ALTER TABLE "BusinessProfile"
  ADD COLUMN "taxTreatment" "TaxTreatment" NOT NULL DEFAULT 'STANDARD';

-- MenuItem: per-item overrides (null = inherit).
ALTER TABLE "MenuItem"
  ADD COLUMN "taxMode" "TaxMode",
  ADD COLUMN "taxTreatment" "TaxTreatment";

-- PosOrderItem: tax snapshot at sale time (null = fall back to BusinessProfile).
ALTER TABLE "PosOrderItem"
  ADD COLUMN "taxRate" DECIMAL(5,2),
  ADD COLUMN "taxMode" "TaxMode",
  ADD COLUMN "taxTreatment" "TaxTreatment";
