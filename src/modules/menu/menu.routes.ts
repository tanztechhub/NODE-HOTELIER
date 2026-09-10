import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { partialNoDefaults } from "../../lib/zod.js";

export const menuRouter = Router();
menuRouter.use(requireModule("POS"));

// Menu item categories live in the shared Category table (scope=RESTAURANT),
// managed via /categories — no separate category CRUD here.
const itemSchema = z.object({
  categoryId: z.string().cuid(),
  productId: z.string().cuid().nullable().optional(),
  recipeId: z.string().cuid().nullable().optional(),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(280).nullable().optional(),
  photoUrl: z.string().trim().max(2000).nullable().optional(),
  price: z.coerce.number().positive(),
  temperature: z.enum(["HOT", "COLD", "OTHER"]).default("OTHER"),
  isVegetarian: z.boolean().default(false),
  isAvailable: z.boolean().default(true),
  addonIds: z.array(z.string().cuid()).default([]),
  // Empty = unallocated = sellable at every location.
  locationIds: z.array(z.string().cuid()).default([]),
});
const addonSchema = z.object({ name: z.string().trim().min(2).max(80), price: z.coerce.number().nonnegative(), isActive: z.boolean().default(true) });
const itemUpdateSchema = partialNoDefaults(itemSchema);
const addonUpdateSchema = partialNoDefaults(addonSchema);
const tenantId = (req: { tenantId?: string }) => { if (!req.tenantId) throw new Error("Tenant context is required"); return req.tenantId; };

// This screen still picks from the generic Category tree; the real link is
// MenuCategory now, so mirror the chosen category into one (find-or-create
// by name) and connect that too. The new Menu ▸ Categories screen is the
// place to actually curate them.
async function menuCategoryIdFor(tid: string, categoryName: string): Promise<string> {
  const existing = await prisma.menuCategory.findFirst({ where: { tenantId: tid, name: categoryName }, select: { id: true } });
  if (existing) return existing.id;
  const created = await prisma.menuCategory.create({ data: { tenantId: tid, name: categoryName }, select: { id: true } });
  return created.id;
}

const itemInclude = { category: true, menuCategory: true, product: true, addons: true, locations: { select: { id: true, name: true } }, recipe: { include: { ingredients: { include: { product: true } } } } } as const;

menuRouter.get("/items", async (req, res) => res.json({ items: await prisma.menuItem.findMany({ where: { tenantId: tenantId(req) }, include: itemInclude, orderBy: { name: "asc" } }) }));
menuRouter.post("/items", async (req, res) => {
  const data = itemSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid menu item", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const category = await prisma.category.findFirst({ where: { id: data.data.categoryId, tenantId: tid, scope: "RESTAURANT" } });
  if (!category) { res.status(400).json({ error: "Choose a menu category from this property" }); return; }
  if (data.data.productId && !(await prisma.product.findFirst({ where: { id: data.data.productId, tenantId: tid } }))) { res.status(400).json({ error: "Choose a product from this property" }); return; }
  if (data.data.recipeId && !(await prisma.recipe.findFirst({ where: { id: data.data.recipeId, tenantId: tid } }))) { res.status(400).json({ error: "Choose a recipe from this property" }); return; }
  if (data.data.addonIds.length) {
    const count = await prisma.addon.count({ where: { id: { in: data.data.addonIds }, tenantId: tid } });
    if (count !== new Set(data.data.addonIds).size) { res.status(400).json({ error: "Every add-on must belong to this property" }); return; }
  }
  if (data.data.locationIds.length) {
    const count = await prisma.location.count({ where: { id: { in: data.data.locationIds }, tenantId: tid } });
    if (count !== new Set(data.data.locationIds).size) { res.status(400).json({ error: "Every location must belong to this property" }); return; }
  }
  const { categoryId, productId, recipeId, addonIds, locationIds, ...item } = data.data;
  const menuCategoryId = await menuCategoryIdFor(tid, category.name);
  res.status(201).json({ item: await prisma.menuItem.create({
    data: { ...item, tenant: { connect: { id: tid } }, category: { connect: { id: categoryId } }, menuCategory: { connect: { id: menuCategoryId } }, ...(productId ? { product: { connect: { id: productId } } } : {}), ...(recipeId ? { recipe: { connect: { id: recipeId } } } : {}), addons: { connect: addonIds.map((id) => ({ id })) }, locations: { connect: locationIds.map((id) => ({ id })) } },
    include: itemInclude,
  }) });
});
menuRouter.patch("/items/:id", async (req, res) => {
  const data = itemUpdateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid menu item", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  const existing = await prisma.menuItem.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!existing) { res.status(404).json({ error: "Menu item not found" }); return; }
  const newCategory = data.data.categoryId
    ? await prisma.category.findFirst({ where: { id: data.data.categoryId, tenantId: tid, scope: "RESTAURANT" } })
    : null;
  if (data.data.categoryId && !newCategory) { res.status(400).json({ error: "Choose a menu category from this property" }); return; }
  if (data.data.addonIds) {
    const count = await prisma.addon.count({ where: { id: { in: data.data.addonIds }, tenantId: tid } });
    if (count !== new Set(data.data.addonIds).size) { res.status(400).json({ error: "Every add-on must belong to this property" }); return; }
  }
  if (data.data.locationIds) {
    const count = await prisma.location.count({ where: { id: { in: data.data.locationIds }, tenantId: tid } });
    if (count !== new Set(data.data.locationIds).size) { res.status(400).json({ error: "Every location must belong to this property" }); return; }
  }
  const { categoryId, productId, recipeId, addonIds, locationIds, ...item } = data.data;
  const menuCategoryId = newCategory ? await menuCategoryIdFor(tid, newCategory.name) : null;
  const updated = await prisma.menuItem.update({
    where: { id: existing.id },
    data: {
      ...item,
      ...(categoryId ? { category: { connect: { id: categoryId } } } : {}),
      ...(menuCategoryId ? { menuCategory: { connect: { id: menuCategoryId } } } : {}),
      ...(productId === null ? { product: { disconnect: true } } : productId ? { product: { connect: { id: productId } } } : {}),
      ...(recipeId === null ? { recipe: { disconnect: true } } : recipeId ? { recipe: { connect: { id: recipeId } } } : {}),
      ...(addonIds ? { addons: { set: addonIds.map((id) => ({ id })) } } : {}),
      ...(locationIds ? { locations: { set: locationIds.map((id) => ({ id })) } } : {}),
    },
    include: itemInclude,
  });
  res.json({ item: updated });
});
menuRouter.delete("/items/:id", async (req, res) => { const deleted = await prisma.menuItem.deleteMany({ where: { id: req.params.id, tenantId: tenantId(req) } }); if (!deleted.count) { res.status(404).json({ error: "Menu item not found" }); return; } res.status(204).send(); });

menuRouter.get("/addons", async (req, res) => res.json({ addons: await prisma.addon.findMany({ where: { tenantId: tenantId(req) }, orderBy: { name: "asc" } }) }));
menuRouter.post("/addons", async (req, res) => { const data = addonSchema.safeParse(req.body); if (!data.success) { res.status(400).json({ error: "Invalid add-on", details: data.error.flatten() }); return; } res.status(201).json({ addon: await prisma.addon.create({ data: { tenantId: tenantId(req), ...data.data } }) }); });
menuRouter.patch("/addons/:id", async (req, res) => { const data = addonUpdateSchema.safeParse(req.body); if (!data.success) { res.status(400).json({ error: "Invalid add-on", details: data.error.flatten() }); return; } const updated = await prisma.addon.updateMany({ where: { id: req.params.id, tenantId: tenantId(req) }, data: data.data }); if (!updated.count) { res.status(404).json({ error: "Add-on not found" }); return; } res.json({ addon: await prisma.addon.findUniqueOrThrow({ where: { id: req.params.id } }) }); });
menuRouter.delete("/addons/:id", async (req, res) => { const deleted = await prisma.addon.deleteMany({ where: { id: req.params.id, tenantId: tenantId(req) } }); if (!deleted.count) { res.status(404).json({ error: "Add-on not found" }); return; } res.status(204).send(); });
