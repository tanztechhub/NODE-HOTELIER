/*
  Warnings:

  - The required column `licenseKey` was added to the `Tenant` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.

*/
-- CreateEnum
CREATE TYPE "LicenseStatus" AS ENUM ('TRIAL', 'ACTIVE', 'EXPIRED', 'SUSPENDED');

-- AlterTable
ALTER TABLE "Tenant" ADD COLUMN     "lastLicenseCheck" TIMESTAMP(3),
ADD COLUMN     "licenseKey" TEXT,
ADD COLUMN     "licenseStatus" "LicenseStatus" NOT NULL DEFAULT 'TRIAL',
ADD COLUMN     "maxBranches" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "maxDevices" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "maxUsers" INTEGER NOT NULL DEFAULT 10,
ADD COLUMN     "nextDueDate" TIMESTAMP(3),
ADD COLUMN     "subscriptionPlan" TEXT NOT NULL DEFAULT 'Hotelier Standard — Yearly',
ADD COLUMN     "subscriptionStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- Backfill existing rows with a generated license key
UPDATE "Tenant" SET "licenseKey" = md5(random()::text || clock_timestamp()::text) WHERE "licenseKey" IS NULL;

-- AlterTable: now that every row has a value, enforce NOT NULL
ALTER TABLE "Tenant" ALTER COLUMN "licenseKey" SET NOT NULL;
