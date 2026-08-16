-- CreateEnum
CREATE TYPE "BusinessType" AS ENUM ('RESTAURANT', 'CAFE', 'HOTEL', 'MOTEL');

-- CreateEnum
CREATE TYPE "Currency" AS ENUM ('KES', 'UGX', 'TZS', 'USD');

-- CreateEnum
CREATE TYPE "TaxMode" AS ENUM ('INCLUSIVE', 'EXCLUSIVE');

-- CreateTable
CREATE TABLE "BusinessProfile" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "logoUrl" TEXT,
    "businessName" TEXT NOT NULL,
    "businessType" "BusinessType" NOT NULL,
    "currency" "Currency" NOT NULL,
    "registrationNumber" TEXT,
    "kraPin" TEXT,
    "taxRate" DECIMAL(5,2),
    "taxMode" "TaxMode" NOT NULL DEFAULT 'EXCLUSIVE',
    "primaryPhone" TEXT,
    "alternativePhone" TEXT,
    "email" TEXT,
    "website" TEXT,
    "country" TEXT,
    "county" TEXT,
    "city" TEXT,
    "address" TEXT,
    "ownerName" TEXT,
    "ownerPhone" TEXT,
    "ownerEmail" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BusinessProfile_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "BusinessProfile_tenantId_key" ON "BusinessProfile"("tenantId");

-- AddForeignKey
ALTER TABLE "BusinessProfile" ADD CONSTRAINT "BusinessProfile_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;
