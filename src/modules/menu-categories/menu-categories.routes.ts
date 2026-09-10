import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { partialNoDefaults } from "../../lib/zod.js";

// Menu ▸ Categories. Its own table (not the generic Category tree) — see the
// MenuCategory model comment. Gated to POS like the rest of the menu module.
export const menuCategoriesRouter = Router();
menuCategoriesRouter.use(requireModule("POS"));

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const createSchema = z.object({
  name: z.string().trim().min(1).max(80),
  description: optionalText(280),
  imageUrl: optionalText(2000),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
  isActive: z.boolean().default(true),
});
const updateSchema = partialNoDefaults(createSchema);
const reorderSchema = z.object({ orderedIds: z.array(z.string().trim().min(1)).min(1) });

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const categoryFields = {
  id: true,
  name: true,
  description: true,
  imageUrl: true,
  sortOrder: true,
  isActive: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { menuItems: true } },
} as const;

const orderBy: Prisma.MenuCategoryOrderByWithRelationInput[] = [{ sortOrder: "asc" }, { name: "asc" }];

menuCategoriesRouter.get("/", async (req, res) => {
  const query = z.object({ search: optionalText(80), active: z.enum(["true", "false"]).optional() }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid category filters", details: query.error.flatten() }); return; }
  const { search, active } = query.data;
  const categories = await prisma.menuCategory.findMany({
    where: {
      tenantId: tenantId(req),
      ...(active ? { isActive: active === "true" } : {}),
      ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
    },
    select: categoryFields,
    orderBy,
  });
  res.json({ categories });
});

menuCategoriesRouter.get("/:id", async (req, res) => {
  const category = await prisma.menuCategory.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: categoryFields });
  if (!category) { res.status(404).json({ error: "Menu category not found" }); return; }
  res.json({ category });
});

menuCategoriesRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid menu category", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    // New categories land at the end unless a position was given.
    let { sortOrder } = data.data;
    if (!req.body || req.body.sortOrder === undefined) {
      const last = await prisma.menuCategory.findFirst({ where: { tenantId: tid }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
      sortOrder = (last?.sortOrder ?? -1) + 1;
    }
    const category = await prisma.menuCategory.create({ data: { tenantId: tid, ...data.data, sortOrder }, select: categoryFields });
    res.status(201).json({ category });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A menu category with this name already exists" }); return; }
    next(error);
  }
});

menuCategoriesRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid menu category", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const updated = await prisma.menuCategory.updateMany({ where: { id: req.params.id, tenantId: tid }, data: data.data });
    if (!updated.count) { res.status(404).json({ error: "Menu category not found" }); return; }
    const category = await prisma.menuCategory.findUniqueOrThrow({ where: { id: req.params.id }, select: categoryFields });
    res.json({ category });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A menu category with this name already exists" }); return; }
    next(error);
  }
});

// Persist a new order — the frontend sends the full id list top-to-bottom.
menuCategoriesRouter.post("/reorder", async (req, res, next) => {
  const data = reorderSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid order", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const owned = await prisma.menuCategory.findMany({ where: { id: { in: data.data.orderedIds }, tenantId: tid }, select: { id: true } });
    if (owned.length !== new Set(data.data.orderedIds).size) { res.status(400).json({ error: "Every category must belong to this property" }); return; }
    await prisma.$transaction(data.data.orderedIds.map((id, index) => prisma.menuCategory.update({ where: { id }, data: { sortOrder: index } })));
    const categories = await prisma.menuCategory.findMany({ where: { tenantId: tid }, select: categoryFields, orderBy });
    res.json({ categories });
  } catch (error) {
    next(error);
  }
});

menuCategoriesRouter.delete("/:id", async (req, res) => {
  const tid = tenantId(req);
  const existing = await prisma.menuCategory.findFirst({ where: { id: req.params.id, tenantId: tid }, select: { id: true, _count: { select: { menuItems: true } } } });
  if (!existing) { res.status(404).json({ error: "Menu category not found" }); return; }
  if (existing._count.menuItems > 0) {
    res.status(409).json({ error: `${existing._count.menuItems} menu item${existing._count.menuItems === 1 ? "" : "s"} use this category — deactivate it instead` });
    return;
  }
  await prisma.menuCategory.delete({ where: { id: existing.id } });
  res.status(204).send();
});
