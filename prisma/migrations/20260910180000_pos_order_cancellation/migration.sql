-- Cancellations now go through admin approval: a waiter requests one with a
-- reason, the order sits in PENDING_CANCELLATION, an admin approves (→
-- CANCELLED) or rejects (→ back to statusBeforeCancel).

ALTER TYPE "PosOrderStatus" ADD VALUE IF NOT EXISTS 'PENDING_CANCELLATION';

ALTER TABLE "PosOrder"
  ADD COLUMN "cancelReason" TEXT,
  ADD COLUMN "cancelRequestedBy" TEXT,
  ADD COLUMN "cancelRequestedAt" TIMESTAMP(3),
  ADD COLUMN "cancelDecidedBy" TEXT,
  ADD COLUMN "cancelDecidedAt" TIMESTAMP(3),
  ADD COLUMN "cancelDecisionNote" TEXT,
  ADD COLUMN "statusBeforeCancel" "PosOrderStatus";
