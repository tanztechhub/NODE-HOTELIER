-- Add-ons become a flat catalog scoped only by an optional menu category.
-- Drop the add-on group system (groups, their rules, and the two joins) and
-- the per-item add-on M2M.

DROP TABLE IF EXISTS "MenuItemAddonGroup";
DROP TABLE IF EXISTS "AddonGroupItem";
DROP TABLE IF EXISTS "AddonGroup";
DROP TABLE IF EXISTS "_AddonToMenuItem";
DROP TYPE IF EXISTS "AddonSelectionType";

ALTER TABLE "Addon" ADD COLUMN "menuCategoryId" TEXT;
ALTER TABLE "Addon"
  ADD CONSTRAINT "Addon_menuCategoryId_fkey"
  FOREIGN KEY ("menuCategoryId") REFERENCES "MenuCategory"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Addon_menuCategoryId_idx" ON "Addon"("menuCategoryId");
