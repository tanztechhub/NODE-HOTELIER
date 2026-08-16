import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";

// Core tenant/business identity — available regardless of which operational
// modules (POS, HR, etc.) the tenant has enabled, so this router is
// intentionally not gated by requireModule.
export const businessProfileRouter = Router();

const businessTypes = ["RESTAURANT", "CAFE", "HOTEL", "MOTEL"] as const;
const currencies = ["KES", "UGX", "TZS", "USD"] as const;
const taxModes = ["INCLUSIVE", "EXCLUSIVE"] as const;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalEmail = z.preprocess(blankToUndefined, z.email().optional());
const optionalRate = z.preprocess(blankToUndefined, z.coerce.number().min(0).max(100).optional());

const profileSchema = z.object({
  logoUrl: optionalText(2000),
  businessName: z.string().trim().min(1).max(150),
  businessType: z.enum(businessTypes),
  currency: z.enum(currencies),
  registrationNumber: optionalText(60),
  kraPin: optionalText(20),
  taxRate: optionalRate,
  taxMode: z.enum(taxModes).default("INCLUSIVE"),
  primaryPhone: optionalText(30),
  alternativePhone: optionalText(30),
  email: optionalEmail,
  website: optionalText(150),
  country: optionalText(80),
  county: optionalText(80),
  city: optionalText(80),
  address: optionalText(255),
  ownerName: optionalText(120),
  ownerPhone: optionalText(30),
  ownerEmail: optionalEmail,
});

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

businessProfileRouter.get("/", async (req, res) => {
  const profile = await prisma.businessProfile.findUnique({ where: { tenantId: tenantId(req) } });
  res.json({ profile });
});

businessProfileRouter.put("/", async (req, res, next) => {
  const data = profileSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid business profile", details: data.error.flatten() }); return; }
  try {
    const profile = await prisma.businessProfile.upsert({
      where: { tenantId: tenantId(req) },
      create: { tenantId: tenantId(req), ...data.data },
      update: data.data,
    });
    res.json({ profile });
  } catch (error) {
    next(error);
  }
});
