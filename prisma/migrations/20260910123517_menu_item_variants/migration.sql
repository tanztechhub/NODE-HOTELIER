-- Phase 3: sized/optioned versions of a menu item, each with its own price.

CREATE TABLE "MenuItemVariant" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sku" TEXT,
    "price" DECIMAL(12,2) NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuItemVariant_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MenuItemVariant_tenantId_menuItemId_name_key" ON "MenuItemVariant"("tenantId", "menuItemId", "name");
CREATE UNIQUE INDEX "MenuItemVariant_tenantId_sku_key" ON "MenuItemVariant"("tenantId", "sku");
CREATE INDEX "MenuItemVariant_tenantId_menuItemId_sortOrder_idx" ON "MenuItemVariant"("tenantId", "menuItemId", "sortOrder");

ALTER TABLE "MenuItemVariant" ADD CONSTRAINT "MenuItemVariant_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MenuItemVariant" ADD CONSTRAINT "MenuItemVariant_menuItemId_fkey"
    FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
