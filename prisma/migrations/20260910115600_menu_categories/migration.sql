-- Phase 1: the Menu module's own category table. Existing RESTAURANT-scoped
-- Category rows are copied in so nothing is lost, and every MenuItem is
-- linked to the matching new row by name (MenuItem keeps its old categoryId
-- for now — POS/Kitchen still read it until a later phase repoints them).

-- CreateTable
CREATE TABLE "MenuCategory" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "imageUrl" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MenuCategory_tenantId_name_key" ON "MenuCategory"("tenantId", "name");
CREATE INDEX "MenuCategory_tenantId_isActive_sortOrder_idx" ON "MenuCategory"("tenantId", "isActive", "sortOrder");

ALTER TABLE "MenuCategory" ADD CONSTRAINT "MenuCategory_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- MenuItem: nullable link to the new table (kept alongside categoryId).
ALTER TABLE "MenuItem" ADD COLUMN "menuCategoryId" TEXT;
CREATE INDEX "MenuItem_tenantId_menuCategoryId_idx" ON "MenuItem"("tenantId", "menuCategoryId");
ALTER TABLE "MenuItem" ADD CONSTRAINT "MenuItem_menuCategoryId_fkey"
    FOREIGN KEY ("menuCategoryId") REFERENCES "MenuCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Backfill: one MenuCategory per existing RESTAURANT-scoped Category,
-- preserving order (level then name) as sortOrder.
INSERT INTO "MenuCategory" ("id", "tenantId", "name", "description", "isActive", "sortOrder", "updatedAt")
SELECT
    gen_random_uuid()::text,
    c."tenantId",
    c."name",
    c."description",
    c."isActive",
    (row_number() OVER (PARTITION BY c."tenantId" ORDER BY c."level", c."name")) - 1,
    CURRENT_TIMESTAMP
FROM "Category" c
WHERE c."scope" IN ('RESTAURANT', 'BAR')
ON CONFLICT ("tenantId", "name") DO NOTHING;

-- Link existing menu items to their matching new category by name.
UPDATE "MenuItem" mi
SET "menuCategoryId" = mc."id"
FROM "Category" c
JOIN "MenuCategory" mc ON mc."tenantId" = c."tenantId" AND mc."name" = c."name"
WHERE mi."categoryId" = c."id";
