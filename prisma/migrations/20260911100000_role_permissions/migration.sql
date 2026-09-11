-- Fine-grained action-level permissions, enforced server-side, separate from
-- the existing allowedSections (which only hides sidebar/routes client-side).

CREATE TYPE "Permission" AS ENUM ('POS_VIEW_ALL_ORDERS', 'POS_APPROVE_COUNTER', 'POS_APPROVE_CANCELLATION');

ALTER TABLE "Role" ADD COLUMN "permissions" "Permission"[] NOT NULL DEFAULT ARRAY[]::"Permission"[];

-- Preserve today's behaviour: cancellation approve/reject was previously
-- gated by a hardcoded role-name check for Super Admin / Manager. Grant
-- those two system roles the equivalent (and pre-grant the other two
-- capabilities so they're already meaningful once the counter workflow and
-- per-employee order visibility land, with no further migration needed).
UPDATE "Role" SET "permissions" = ARRAY['POS_VIEW_ALL_ORDERS', 'POS_APPROVE_COUNTER', 'POS_APPROVE_CANCELLATION']::"Permission"[]
  WHERE "name" IN ('Super Admin', 'Manager');
