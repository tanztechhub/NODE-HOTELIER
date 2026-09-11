-- Records which employee rang an order up, so the order list can be scoped
-- to "my own" for staff without cross-employee visibility. Null on existing
-- rows — history predates this field and isn't attributable.
ALTER TABLE "PosOrder" ADD COLUMN "createdBy" TEXT;
