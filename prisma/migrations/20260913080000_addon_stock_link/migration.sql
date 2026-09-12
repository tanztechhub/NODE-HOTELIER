-- Optional stock link for an add-on, mirroring MenuItemVariant's own
-- stockProductId/stockQtyPerUnit: lets an add-on (e.g. "Extra Red Bull",
-- "Double shot") consume a fixed quantity of a stock Product when sold.
ALTER TABLE "Addon" ADD COLUMN "stockProductId" TEXT;
ALTER TABLE "Addon" ADD COLUMN "stockQtyPerUnit" DECIMAL(12,3);

ALTER TABLE "Addon" ADD CONSTRAINT "Addon_stockProductId_fkey"
  FOREIGN KEY ("stockProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
