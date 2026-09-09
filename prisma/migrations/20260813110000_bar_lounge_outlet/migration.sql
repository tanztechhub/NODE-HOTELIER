CREATE TYPE "OutletKey" AS ENUM ('CAFE', 'BAR_LOUNGE');
ALTER TABLE "MenuItem" ADD COLUMN "outlet" "OutletKey" NOT NULL DEFAULT 'CAFE';
ALTER TABLE "PosOrder" ADD COLUMN "outlet" "OutletKey" NOT NULL DEFAULT 'CAFE';
CREATE INDEX "MenuItem_tenantId_outlet_idx" ON "MenuItem"("tenantId", "outlet");
CREATE INDEX "PosOrder_tenantId_outlet_status_idx" ON "PosOrder"("tenantId", "outlet", "status");
