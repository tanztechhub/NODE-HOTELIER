-- DropIndex
DROP INDEX "Addon_menuCategoryId_idx";

-- DropIndex
DROP INDEX "Employee_defaultLocationId_idx";

-- AlterTable
ALTER TABLE "MenuItem" ADD COLUMN     "stockQtyPerUnit" DECIMAL(12,3);

-- AlterTable
ALTER TABLE "MenuItemVariant" ADD COLUMN     "stockProductId" TEXT,
ADD COLUMN     "stockQtyPerUnit" DECIMAL(12,3);

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "packLabel" TEXT,
ADD COLUMN     "packSize" DECIMAL(12,3),
ADD COLUMN     "packUnitId" TEXT;

-- CreateIndex
CREATE INDEX "Addon_tenantId_menuCategoryId_idx" ON "Addon"("tenantId", "menuCategoryId");

-- AddForeignKey
ALTER TABLE "Product" ADD CONSTRAINT "Product_packUnitId_fkey" FOREIGN KEY ("packUnitId") REFERENCES "UnitOfMeasure"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MenuItemVariant" ADD CONSTRAINT "MenuItemVariant_stockProductId_fkey" FOREIGN KEY ("stockProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
