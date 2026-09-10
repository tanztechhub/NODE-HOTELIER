import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { partialNoDefaults } from "../../lib/zod.js";

// Menu ▸ Items (Phase 2). The new, richer menu-item CRUD built on the
// dedicated MenuCategory table. `isActive` (in the menu at all) and
// `isAvailable` (currently sellable) are deliberately separate. Recipe /
// product / inventory linkage is intentionally NOT handled here.
export const menuItemsRouter = Router();
menuItemsRouter.use(requireModule("POS"));

const DRINK_TEMPS = ["HOT", "COLD", "OTHER"] as const;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalNumber = (opts: { min?: number; max?: number } = {}) =>
  z.preprocess(blankToUndefined, z.coerce.number().min(opts.min ?? -Infinity).max(opts.max ?? Infinity).optional());

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  shortName: optionalText(40),
  menuCategoryId: z.string().trim().min(1, "Choose a category"),
  description: optionalText(500),
  sku: optionalText(60),
  price: z.coerce.number().min(0, "Price cannot be negative").max(9_999_999),
  taxRate: optionalNumber({ min: 0, max: 100 }),
  photoUrl: optionalText(2000),
  temperature: z.enum(DRINK_TEMPS).default("OTHER"),
  isVegetarian: z.boolean().default(false),
  isActive: z.boolean().default(true),
  isAvailable: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(99999).optional(),
});
const updateSchema = partialNoDefaults(createSchema);
const reorderSchema = z.object({ menuCategoryId: z.string().trim().min(1), orderedIds: z.array(z.string().trim().min(1)).min(1) });

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const itemFields = {
  id: true,
  name: true,
  shortName: true,
  menuCategoryId: true,
  menuCategory: { select: { id: true, name: true, isActive: true } },
  description: true,
  sku: true,
  price: true,
  taxRate: true,
  photoUrl: true,
  temperature: true,
  isVegetarian: true,
  isActive: true,
  isAvailable: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { orderItems: true } },
} as const;

const orderBy: Prisma.MenuItemOrderByWithRelationInput[] = [
  { menuCategory: { sortOrder: "asc" } },
  { sortOrder: "asc" },
  { name: "asc" },
];

async function assertCategory(tid: string, menuCategoryId: string) {
  const category = await prisma.menuCategory.findFirst({ where: { id: menuCategoryId, tenantId: tid }, select: { id: true } });
  if (!category) throw Object.assign(new Error("Selected category was not found"), { status: 400 });
}

menuItemsRouter.get("/", async (req, res, next) => {
  try {
    const query = z.object({
      search: optionalText(120),
      categoryId: z.string().trim().optional(),
      active: z.enum(["true", "false"]).optional(),
      available: z.enum(["true", "false"]).optional(),
    }).safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid item filters", details: query.error.flatten() }); return; }
    const { search, categoryId, active, available } = query.data;
    const items = await prisma.menuItem.findMany({
      where: {
        tenantId: tenantId(req),
        ...(categoryId ? { menuCategoryId: categoryId } : {}),
        ...(active ? { isActive: active === "true" } : {}),
        ...(available ? { isAvailable: available === "true" } : {}),
        ...(search ? { OR: [
          { name: { contains: search, mode: "insensitive" } },
          { shortName: { contains: search, mode: "insensitive" } },
          { sku: { contains: search, mode: "insensitive" } },
        ] } : {}),
      },
      select: itemFields,
      orderBy,
    });
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

menuItemsRouter.get("/:id", async (req, res, next) => {
  try {
    const item = await prisma.menuItem.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: itemFields });
    if (!item) { res.status(404).json({ error: "Menu item not found" }); return; }
    res.json({ item });
  } catch (error) {
    next(error);
  }
});

menuItemsRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid menu item", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    await assertCategory(tid, data.data.menuCategoryId);
    let { sortOrder } = data.data;
    if (sortOrder === undefined) {
      const last = await prisma.menuItem.findFirst({ where: { tenantId: tid, menuCategoryId: data.data.menuCategoryId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
      sortOrder = (last?.sortOrder ?? -1) + 1;
    }
    const item = await prisma.menuItem.create({ data: { tenantId: tid, ...data.data, sortOrder }, select: itemFields });
    res.status(201).json({ item });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A menu item with this SKU already exists" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

menuItemsRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid menu item", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    if (data.data.menuCategoryId) await assertCategory(tid, data.data.menuCategoryId);
    const updated = await prisma.menuItem.updateMany({ where: { id: req.params.id, tenantId: tid }, data: data.data });
    if (!updated.count) { res.status(404).json({ error: "Menu item not found" }); return; }
    const item = await prisma.menuItem.findUniqueOrThrow({ where: { id: req.params.id }, select: itemFields });
    res.json({ item });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A menu item with this SKU already exists" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

menuItemsRouter.post("/reorder", async (req, res, next) => {
  const data = reorderSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid order", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const owned = await prisma.menuItem.count({ where: { id: { in: data.data.orderedIds }, tenantId: tid, menuCategoryId: data.data.menuCategoryId } });
    if (owned !== new Set(data.data.orderedIds).size) { res.status(400).json({ error: "Every item must belong to this category" }); return; }
    await prisma.$transaction(data.data.orderedIds.map((id, index) => prisma.menuItem.update({ where: { id }, data: { sortOrder: index } })));
    const items = await prisma.menuItem.findMany({ where: { tenantId: tid, menuCategoryId: data.data.menuCategoryId }, select: itemFields, orderBy });
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

menuItemsRouter.delete("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.menuItem.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: { id: true, _count: { select: { orderItems: true } } } });
    if (!existing) { res.status(404).json({ error: "Menu item not found" }); return; }
    if (existing._count.orderItems > 0) {
      res.status(409).json({ error: `This item is on ${existing._count.orderItems} order${existing._count.orderItems === 1 ? "" : "s"} — deactivate it instead` });
      return;
    }
    // Also clears the row's add-on / location links (implicit M2M join rows).
    await prisma.menuItem.delete({ where: { id: existing.id } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
