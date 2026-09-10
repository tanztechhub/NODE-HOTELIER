-- Per-item switch for the POS add-on prompt. Default off: an item only
-- offers add-ons once it's explicitly turned on, so simple items (a latte)
-- drop straight onto the order.
ALTER TABLE "MenuItem" ADD COLUMN "allowsAddons" BOOLEAN NOT NULL DEFAULT false;
