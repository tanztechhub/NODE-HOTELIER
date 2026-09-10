-- Phase 7: attach reusable add-on groups to menu items (M2M, per-item order).

CREATE TABLE "MenuItemAddonGroup" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "menuItemId" TEXT NOT NULL,
    "addonGroupId" TEXT NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MenuItemAddonGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "MenuItemAddonGroup_menuItemId_addonGroupId_key" ON "MenuItemAddonGroup"("menuItemId", "addonGroupId");
CREATE INDEX "MenuItemAddonGroup_tenantId_menuItemId_sortOrder_idx" ON "MenuItemAddonGroup"("tenantId", "menuItemId", "sortOrder");

ALTER TABLE "MenuItemAddonGroup" ADD CONSTRAINT "MenuItemAddonGroup_tenantId_fkey"
    FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MenuItemAddonGroup" ADD CONSTRAINT "MenuItemAddonGroup_menuItemId_fkey"
    FOREIGN KEY ("menuItemId") REFERENCES "MenuItem"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "MenuItemAddonGroup" ADD CONSTRAINT "MenuItemAddonGroup_addonGroupId_fkey"
    FOREIGN KEY ("addonGroupId") REFERENCES "AddonGroup"("id") ON DELETE CASCADE ON UPDATE CASCADE;
