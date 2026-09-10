-- Phase 4: reusable add-on selection rule-sets.

CREATE TYPE "AddonSelectionType" AS ENUM ('SINGLE', 'MULTIPLE');

CREATE TABLE "AddonGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "selectionType" "AddonSelectionType" NOT NULL DEFAULT 'SINGLE',
    "minSelections" INTEGER NOT NULL DEFAULT 0,
    "maxSelections" INTEGER NOT NULL DEFAULT 1,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AddonGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AddonGroup_tenantId_name_key" ON "AddonGroup"("tenantId", "name");
CREATE INDEX "AddonGroup_tenantId_isActive_sortOrder_idx" ON "AddonGroup"("tenantId", "isActive", "sortOrder");

ALTER TABLE "AddonGroup" ADD CONSTRAINT "AddonGroup_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
