-- Phase 2: MenuItem gets its Phase-2 shape.
-- menuCategoryId becomes the real (required) category link — it was
-- backfilled for every row in the previous migration. The legacy categoryId
-- (generic Category tree) is demoted to an optional column so the old
-- Menu & Add-ons screen keeps working; new items won't set it.

-- Drop the old required FK + index, re-add categoryId as nullable SET NULL.
ALTER TABLE "MenuItem" DROP CONSTRAINT "MenuItem_categoryId_fkey";
ALTER TABLE "MenuItem" ALTER COLUMN "categoryId" DROP NOT NULL;
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- menuCategoryId: required + RESTRICT (was nullable in Phase 1).
ALTER TABLE "MenuItem" DROP CONSTRAINT "MenuItem_menuCategoryId_fkey";
ALTER TABLE "MenuItem" ALTER COLUMN "menuCategoryId" SET NOT NULL;
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_menuCategoryId_fkey"
    FOREIGN KEY ("menuCategoryId") REFERENCES "MenuCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- New Phase-2 columns.
ALTER TABLE "MenuItem" ADD COLUMN "shortName" TEXT;
ALTER TABLE "MenuItem" ADD COLUMN "sku" TEXT;
ALTER TABLE "MenuItem" ADD COLUMN "taxRate" DECIMAL(5,2);
ALTER TABLE "MenuItem" ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "MenuItem" ADD COLUMN "sortOrder" INTEGER NOT NULL DEFAULT 0;

-- Swap the plain menuCategoryId index for one that also carries sortOrder.
DROP INDEX "MenuItem_tenantId_menuCategoryId_idx";
CREATE INDEX "MenuItem_tenantId_menuCategoryId_sortOrder_idx" ON "MenuItem"("tenantId", "menuCategoryId", "sortOrder");
CREATE UNIQUE INDEX "MenuItem_tenantId_sku_key" ON "MenuItem"("tenantId", "sku");

-- Give existing items a stable order within their category (by name).
UPDATE "MenuItem" mi
SET "sortOrder" = sub.rn - 1
FROM (
    SELECT "id", row_number() OVER (PARTITION BY "menuCategoryId" ORDER BY "name") AS rn
    FROM "MenuItem"
) sub
WHERE sub."id" = mi."id";
