-- Public, no-auth receipt link support: an opaque per-order token.
ALTER TABLE "PosOrder" ADD COLUMN "shareToken" TEXT;

CREATE UNIQUE INDEX "PosOrder_shareToken_key" ON "PosOrder"("shareToken");
