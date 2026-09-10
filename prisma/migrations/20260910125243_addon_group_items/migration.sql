-- Phase 6: M2M between add-on groups and add-ons, with per-group ordering.

CREATE TABLE "AddonGroupItem" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "addonGroupId" TEXT NOT NULL,
    "addonId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AddonGroupItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AddonGroupItem_addonGroupId_addonId_key" ON "AddonGroupItem"("addonGroupId", "addonId");
CREATE INDEX "AddonGroupItem_tenantId_addonGroupId_sortOrder_idx" ON "AddonGroupItem"("tenantId", "addonGroupId", "sortOrder");

ALTER TABLE "AddonGroupItem" ADD CONSTRAINT "AddonGroupItem_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AddonGroupItem" ADD CONSTRAINT "AddonGroupItem_addonGroupId_fkey"
    FOREIGN KEY ("addonGroupId") REFERENCES "AddonGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AddonGroupItem" ADD CONSTRAINT "AddonGroupItem_addonId_fkey"
    FOREIGN KEY ("addonId") REFERENCES "Addon"("id") ON DELETE CASCADE ON UPDATE CASCADE;
