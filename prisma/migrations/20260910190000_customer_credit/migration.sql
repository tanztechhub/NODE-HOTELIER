-- Customer credit: a POS order can be completed without full payment, the
-- shortfall going onto the customer's running balance, with every movement
-- recorded in a ledger.

CREATE TYPE "PosPaymentStatus" AS ENUM ('UNPAID', 'PARTIAL', 'PAID');
CREATE TYPE "CustomerCreditType" AS ENUM ('CREDIT', 'REPAYMENT', 'ADJUSTMENT');

ALTER TABLE "PosOrder" ADD COLUMN "paymentStatus" "PosPaymentStatus" NOT NULL DEFAULT 'UNPAID';
ALTER TABLE "Customer" ADD COLUMN "balance" DECIMAL(12,2) NOT NULL DEFAULT 0;

-- Backfill: completed orders were only ever completed at full payment; any
-- non-completed order that already has a payment is PARTIAL.
UPDATE "PosOrder" SET "paymentStatus" = 'PAID' WHERE "status" = 'COMPLETED';
UPDATE "PosOrder" o SET "paymentStatus" = 'PARTIAL'
  WHERE o."status" <> 'COMPLETED' AND EXISTS (SELECT 1 FROM "Payment" p WHERE p."orderId" = o."id");

CREATE TABLE "CustomerCreditEntry" (
  "id" TEXT NOT NULL,
  "tenantId" TEXT NOT NULL,
  "customerId" TEXT NOT NULL,
  "orderId" TEXT,
  "type" "CustomerCreditType" NOT NULL DEFAULT 'CREDIT',
  "amount" DECIMAL(12,2) NOT NULL,
  "balanceAfter" DECIMAL(12,2) NOT NULL,
  "note" TEXT,
  "createdBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerCreditEntry_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "CustomerCreditEntry"
  ADD CONSTRAINT "CustomerCreditEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CustomerCreditEntry_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "CustomerCreditEntry_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "PosOrder"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "CustomerCreditEntry_tenantId_customerId_createdAt_idx" ON "CustomerCreditEntry"("tenantId", "customerId", "createdAt");
CREATE INDEX "CustomerCreditEntry_orderId_idx" ON "CustomerCreditEntry"("orderId");
