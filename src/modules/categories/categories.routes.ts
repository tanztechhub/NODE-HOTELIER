import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";

export const categoriesRouter = Router();
categoriesRouter.use(requireModule("STORE"));

const MAX_LEVEL = 3;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalId = z.preprocess(blankToUndefined, z.string().trim().optional());

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: optionalText(255),
  parentId: optionalId,
  isActive: z.boolean().default(true),
});
const updateSchema = createSchema.partial();

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const categoryFields = {
  id: true,
  name: true,
  description: true,
  parentId: true,
  level: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { children: true, products: true } },
} as const;

class HttpError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function resolveLevel(tid: string, parentId: string | undefined, selfId?: string): Promise<number> {
  if (!parentId) return 1;
  if (parentId === selfId) throw new HttpError(400, "A category cannot be its own parent");
  const parent = await prisma.category.findFirst({ where: { id: parentId, tenantId: tid } });
  if (!parent) throw new HttpError(400, "Parent category not found");
  if (parent.level >= MAX_LEVEL) throw new HttpError(400, `Categories can only be nested ${MAX_LEVEL} levels deep`);
  return parent.level + 1;
}

async function assertNameAvailable(tid: string, parentId: string | null, name: string, excludeId?: string) {
  const sibling = await prisma.category.findFirst({
    where: { tenantId: tid, parentId, name: { equals: name, mode: "insensitive" }, ...(excludeId ? { NOT: { id: excludeId } } : {}) },
  });
  if (sibling) throw new HttpError(409, "A category with this name already exists at this level");
}

categoriesRouter.get("/", async (req, res) => {
  const categories = await prisma.category.findMany({
    where: { tenantId: tenantId(req) },
    select: categoryFields,
    orderBy: [{ level: "asc" }, { name: "asc" }],
  });
  res.json({ categories });
});

categoriesRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid category", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const level = await resolveLevel(tid, data.data.parentId);
    await assertNameAvailable(tid, data.data.parentId ?? null, data.data.name);
    const category = await prisma.category.create({
      data: { tenantId: tid, name: data.data.name, description: data.data.description, parentId: data.data.parentId, isActive: data.data.isActive, level },
      select: categoryFields,
    });
    res.status(201).json({ category });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    next(error);
  }
});

categoriesRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid category", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const existing = await prisma.category.findFirst({ where: { id: req.params.id, tenantId: tid } });
    if (!existing) { res.status(404).json({ error: "Category not found" }); return; }

    let level = existing.level;
    if (data.data.parentId !== undefined) {
      level = await resolveLevel(tid, data.data.parentId, existing.id);
      if (level !== existing.level) {
        const childCount = await prisma.category.count({ where: { parentId: existing.id } });
        if (childCount > 0) throw new HttpError(400, "Move or remove this category's subcategories before changing its parent");
      }
    }
    if (data.data.name) {
      const parentId = data.data.parentId !== undefined ? (data.data.parentId ?? null) : existing.parentId;
      await assertNameAvailable(tid, parentId, data.data.name, existing.id);
    }

    const updated = await prisma.category.update({
      where: { id: existing.id },
      data: { ...data.data, level },
      select: categoryFields,
    });
    res.json({ category: updated });
  } catch (error) {
    if (error instanceof HttpError) { res.status(error.status).json({ error: error.message }); return; }
    next(error);
  }
});

categoriesRouter.delete("/:id", async (req, res) => {
  const tid = tenantId(req);
  const existing = await prisma.category.findFirst({
    where: { id: req.params.id, tenantId: tid },
    select: { id: true, _count: { select: { children: true, products: true } } },
  });
  if (!existing) { res.status(404).json({ error: "Category not found" }); return; }
  if (existing._count.children > 0) { res.status(409).json({ error: "Remove or move its subcategories first" }); return; }
  if (existing._count.products > 0) { res.status(409).json({ error: "Reassign or remove its products first" }); return; }
  await prisma.category.delete({ where: { id: existing.id } });
  res.status(204).send();
});
