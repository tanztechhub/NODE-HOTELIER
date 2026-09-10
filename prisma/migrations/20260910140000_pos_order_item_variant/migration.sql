-- Records the specific MenuItemVariant chosen for a POS order line, so a
-- sized/optioned sale (Pizza: Large) keeps its selection on receipts and KOTs.
ALTER TABLE "PosOrderItem" ADD COLUMN "variantId" TEXT;

ALTER TABLE "PosOrderItem"
  ADD CONSTRAINT "PosOrderItem_variantId_fkey"
  FOREIGN KEY ("variantId") REFERENCES "MenuItemVariant"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "PosOrderItem_variantId_idx" ON "PosOrderItem"("variantId");
