import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";

// Read-only tenant/license info — not gated by requireModule since every
// tenant, regardless of which operational modules are enabled, should be
// able to see their own license and subscription standing.
export const tenantRouter = Router();

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const resolveSchema = z.object({ slug: z.string().trim().min(1).toLowerCase() });

/**
 * Public, tenant-agnostic: resolves a subdomain slug (e.g. "grandpalace"
 * from grandpalace.tanzhotelier.app) to a tenant id. This is the one
 * endpoint the frontend can call before it knows which tenant it's
 * talking to — every other route requires x-tenant-id already set.
 */
tenantRouter.get("/resolve", async (req, res) => {
  const query = resolveSchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "A workspace slug is required" }); return; }
  const tenant = await prisma.tenant.findFirst({
    where: { slug: query.data.slug, isActive: true },
    select: { id: true, name: true, slug: true },
  });
  if (!tenant) { res.status(404).json({ error: "This workspace could not be found" }); return; }
  res.json({ tenant });
});

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
