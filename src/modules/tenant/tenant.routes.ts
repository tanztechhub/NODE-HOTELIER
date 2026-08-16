import { Router } from "express";
import { prisma } from "../../lib/prisma.js";

// Read-only tenant/license info — not gated by requireModule since every
// tenant, regardless of which operational modules are enabled, should be
// able to see their own license and subscription standing.
export const tenantRouter = Router();

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

tenantRouter.get("/license", async (req, res) => {
  const tenant = await prisma.tenant.update({
    where: { id: tenantId(req) },
    data: { lastLicenseCheck: new Date() },
    select: {
      id: true,
      licenseKey: true,
      licenseStatus: true,
      subscriptionPlan: true,
      subscriptionStart: true,
      nextDueDate: true,
      maxBranches: true,
      maxUsers: true,
      maxDevices: true,
      lastLicenseCheck: true,
      isActive: true,
    },
  });
  res.json({ license: tenant });
});
