-- Phase 5: richer reusable add-ons.
ALTER TABLE "Addon" ADD COLUMN "description" TEXT;
ALTER TABLE "Addon" ADD COLUMN "sku" TEXT;
ALTER TABLE "Addon" ADD COLUMN "imageUrl" TEXT;
CREATE UNIQUE INDEX "Addon_tenantId_sku_key" ON "Addon"("tenantId", "sku");
