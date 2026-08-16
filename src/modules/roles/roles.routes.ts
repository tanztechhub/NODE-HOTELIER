import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";

export const rolesRouter = Router();

const sections = ["OVERVIEW", "RECEPTION", "HOUSEKEEPING", "SALES", "KITCHEN", "SERVICE_CENTER", "INVENTORY", "TEAM", "FINANCE", "REPORTS", "SYSTEM"] as const;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);

const createSchema = z.object({
  name: z.string().trim().min(1).max(60),
  description: z.preprocess(blankToUndefined, z.string().trim().max(200).optional()),
  allowedSections: z.array(z.enum(sections)).default([]),
});
const updateSchema = createSchema.partial();

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const publicFields = {
  id: true,
  name: true,
  description: true,
  isSystemRole: true,
  allowedSections: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { employees: true } },
} as const;

function serialize<T extends { _count: { employees: number } }>(role: T) {
  const { _count, ...rest } = role;
  return { ...rest, employeeCount: _count.employees };
}

rolesRouter.get("/", async (req, res) => {
  const [roles, total, systemCount] = await Promise.all([
    prisma.role.findMany({ where: { tenantId: tenantId(req) }, select: publicFields, orderBy: [{ isSystemRole: "desc" }, { name: "asc" }] }),
    prisma.role.count({ where: { tenantId: tenantId(req) } }),
    prisma.role.count({ where: { tenantId: tenantId(req), isSystemRole: true } }),
  ]);
  res.json({ roles: roles.map(serialize), summary: { total, system: systemCount, custom: total - systemCount } });
});

rolesRouter.get("/:id", async (req, res) => {
  const role = await prisma.role.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: publicFields });
  if (!role) { res.status(404).json({ error: "Role not found" }); return; }
  res.json({ role: serialize(role) });
});

rolesRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid role", details: data.error.flatten() }); return; }
  try {
    const role = await prisma.role.create({ data: { tenantId: tenantId(req), ...data.data }, select: publicFields });
    res.status(201).json({ role: serialize(role) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A role with this name already exists" }); return; }
    next(error);
  }
});

rolesRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid role", details: data.error.flatten() }); return; }
  try {
    const updated = await prisma.role.updateMany({ where: { id: req.params.id, tenantId: tenantId(req) }, data: data.data });
    if (!updated.count) { res.status(404).json({ error: "Role not found" }); return; }
    const role = await prisma.role.findUniqueOrThrow({ where: { id: req.params.id }, select: publicFields });
    res.json({ role: serialize(role) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A role with this name already exists" }); return; }
    next(error);
  }
});

rolesRouter.delete("/:id", async (req, res) => {
  const role = await prisma.role.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) } });
  if (!role) { res.status(404).json({ error: "Role not found" }); return; }
  if (role.isSystemRole) { res.status(400).json({ error: "System roles cannot be deleted" }); return; }
  await prisma.role.delete({ where: { id: role.id } });
  res.status(204).send();
});
