import { Router } from "express";
import { z } from "zod";

import { requireModule } from "../../middleware/tenantContext.js";
import { prisma } from "../../lib/prisma.js";

// POS configuration, stores, and stock all remain scoped to the tenant supplied
// by the authenticated request context (currently x-tenant-id during scaffolding).
export const posRouter = Router();

posRouter.use(requireModule("POS"));

const settingsSchema = z.object({
  cafeName: z.string().trim().min(2).max(120),
  currency: z.string().trim().length(3).transform((value) => value.toUpperCase()),
  inventoryEnabled: z.boolean(),
  lowStockAlerts: z.boolean(),
});

const storeSchema = z.object({
  name: z.string().trim().min(2).max(80),
  code: z.string().trim().min(2).max(20).transform((value) => value.toUpperCase()),
});

const itemSchema = z.object({
  storeId: z.string().cuid(),
  name: z.string().trim().min(2).max(120),
  sku: z.string().trim().min(2).max(40).transform((value) => value.toUpperCase()),
  unit: z.string().trim().min(1).max(20).default("each"),
  quantity: z.coerce.number().min(0),
  reorderLevel: z.coerce.number().min(0),
});

const menuItemSchema = z.object({
  category: z.string().trim().min(2).max(60),
  productId: z.string().cuid().optional(),
  name: z.string().trim().min(2).max(120),
  description: z.string().trim().max(280).optional(),
  price: z.coerce.number().positive(),
  temperature: z.enum(["HOT", "COLD", "OTHER"]).default("OTHER"),
  isAvailable: z.boolean().default(true),
});

const adjustmentSchema = z.object({
  quantity: z.coerce.number().finite().refine((value) => value !== 0, "Quantity cannot be zero"),
});
const addonSchema = z.object({ name: z.string().trim().min(2).max(80), price: z.coerce.number().nonnegative(), isActive: z.boolean().default(true) });
const orderSchema = z.object({ tableLabel: z.string().trim().max(60).optional(), notes: z.string().trim().max(500).optional(), items: z.array(z.object({ menuItemId: z.string().cuid(), quantity: z.coerce.number().int().min(1).max(50), addons: z.array(z.object({ addonId: z.string().cuid(), quantity: z.coerce.number().int().min(1).max(20).default(1) })).default([]) })).min(1) });

function tenantIdFor(request: { tenantId?: string }): string {
  if (!request.tenantId) throw new Error("Tenant context is required");
  return request.tenantId;
}

posRouter.get("/orders", async (req, res) => {
  const orders = await prisma.posOrder.findMany({ where: { tenantId: tenantIdFor(req) }, include: { items: { include: { menuItem: true, addons: { include: { addon: true } } } } }, orderBy: { createdAt: "desc" } });
  res.status(200).json({ orders });
});

/** POS notification queue: Kitchen places finished orders here for serving. */
posRouter.get("/orders/ready", async (req, res) => {
  const orders = await prisma.posOrder.findMany({ where: { tenantId: tenantIdFor(req), status: "READY" }, include: { items: { include: { menuItem: true, addons: { include: { addon: true } } } } }, orderBy: { readyAt: "asc" } });
  res.status(200).json({ notifications: orders.map((order) => ({ type: "ORDER_READY", message: `Order #${order.orderNumber} is ready to serve`, order })) });
});

posRouter.post("/orders", async (req, res) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid order", details: parsed.error.flatten() }); return; }
  const tid = tenantIdFor(req);
  const menuItemIds = parsed.data.items.map((item) => item.menuItemId);
  const addonIds = parsed.data.items.flatMap((item) => item.addons.map((addon) => addon.addonId));
  const menuItems = await prisma.menuItem.findMany({ where: { id: { in: menuItemIds }, tenantId: tid, isAvailable: true } });
  if (menuItems.length !== new Set(menuItemIds).size) { res.status(400).json({ error: "Every order item must be an available menu item from this café" }); return; }
  const addons = addonIds.length ? await prisma.addon.findMany({ where: { id: { in: addonIds }, tenantId: tid, isActive: true } }) : [];
  if (addons.length !== new Set(addonIds).size) { res.status(400).json({ error: "Every add-on must be an active add-on from this café" }); return; }
  const prices = new Map(menuItems.map((item) => [item.id, item.price]));
  const addonPrices = new Map(addons.map((addon) => [addon.id, addon.price]));
  const order = await prisma.$transaction(async (tx) => {
    const last = await tx.posOrder.findFirst({ where: { tenantId: tid }, orderBy: { orderNumber: "desc" }, select: { orderNumber: true } });
    return tx.posOrder.create({ data: { tenantId: tid, orderNumber: (last?.orderNumber ?? 0) + 1, tableLabel: parsed.data.tableLabel, notes: parsed.data.notes, status: "OPEN", items: { create: parsed.data.items.map((item) => ({ menuItemId: item.menuItemId, quantity: item.quantity, unitPrice: prices.get(item.menuItemId)!, addons: { create: item.addons.map((addon) => ({ addonId: addon.addonId, quantity: addon.quantity, unitPrice: addonPrices.get(addon.addonId)! })) } })) } }, include: { items: { include: { menuItem: true, addons: { include: { addon: true } } } } } });
  });
  res.status(201).json({ order });
});

posRouter.patch("/orders/:id/serve", async (req, res) => {
  const order = await prisma.posOrder.updateMany({ where: { id: req.params.id, tenantId: tenantIdFor(req), status: "READY" }, data: { status: "COMPLETED", servedAt: new Date() } });
  if (!order.count) { res.status(404).json({ error: "Ready order not found" }); return; }
  res.status(200).json({ order: await prisma.posOrder.findUniqueOrThrow({ where: { id: req.params.id } }) });
});

posRouter.get("/orders/:id", async (req, res) => {
  const order = await prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tenantIdFor(req) }, include: { items: { include: { menuItem: true, addons: { include: { addon: true } } } } } });
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  res.status(200).json({ order });
});

/** Reusable client add-ons, selected by cashiers for individual orders. */
posRouter.get("/addons", async (req, res) => res.json({ addons: await prisma.addon.findMany({ where: { tenantId: tenantIdFor(req) }, orderBy: { name: "asc" } }) }));
posRouter.post("/addons", async (req, res) => { const data = addonSchema.safeParse(req.body); if (!data.success) { res.status(400).json({ error: "Invalid add-on", details: data.error.flatten() }); return; } res.status(201).json({ addon: await prisma.addon.create({ data: { tenantId: tenantIdFor(req), ...data.data } }) }); });
posRouter.patch("/addons/:id", async (req, res) => { const data = addonSchema.partial().safeParse(req.body); if (!data.success) { res.status(400).json({ error: "Invalid add-on", details: data.error.flatten() }); return; } const updated = await prisma.addon.updateMany({ where: { id: req.params.id, tenantId: tenantIdFor(req) }, data: data.data }); if (!updated.count) { res.status(404).json({ error: "Add-on not found" }); return; } res.json({ addon: await prisma.addon.findUniqueOrThrow({ where: { id: req.params.id } }) }); });
posRouter.delete("/addons/:id", async (req, res) => { const deleted = await prisma.addon.deleteMany({ where: { id: req.params.id, tenantId: tenantIdFor(req) } }); if (!deleted.count) { res.status(404).json({ error: "Add-on not found" }); return; } res.status(204).send(); });

/** Returns the full configuration needed to operate a café POS. */
posRouter.get("/settings", async (req, res) => {
  const tenantId = tenantIdFor(req);
  const [settings, stores, inventory] = await Promise.all([
    prisma.cafeSettings.findUnique({ where: { tenantId } }),
    prisma.store.findMany({ where: { tenantId }, orderBy: { name: "asc" } }),
    prisma.product.findMany({ where: { tenantId }, include: { store: true }, orderBy: { name: "asc" } }),
  ]);

  res.status(200).json({ settings, stores, inventory });
});

/** Creates or updates the café-wide POS and inventory policy. */
posRouter.put("/settings", async (req, res) => {
  const parsed = settingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid café settings", details: parsed.error.flatten() });
    return;
  }

  const settings = await prisma.cafeSettings.upsert({
    where: { tenantId: tenantIdFor(req) },
    create: { tenantId: tenantIdFor(req), ...parsed.data },
    update: parsed.data,
  });

  res.status(200).json({ settings });
});

posRouter.post("/stores", async (req, res) => {
  const parsed = storeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid store", details: parsed.error.flatten() });
    return;
  }

  const store = await prisma.store.create({
    data: { tenantId: tenantIdFor(req), ...parsed.data },
  });
  res.status(201).json({ store });
});

posRouter.post("/inventory/items", async (req, res) => {
  const parsed = itemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid inventory item", details: parsed.error.flatten() });
    return;
  }

  const tenantId = tenantIdFor(req);
  const store = await prisma.store.findFirst({ where: { id: parsed.data.storeId, tenantId, isActive: true } });
  if (!store) {
    res.status(400).json({ error: "Choose an active store belonging to this café" });
    return;
  }

  const item = await prisma.product.create({ data: { tenantId, ...parsed.data } });
  res.status(201).json({ item });
});

/** Lists the café items the cashier can add to an order. */
posRouter.get("/menu-items", async (req, res) => {
  const items = await prisma.menuItem.findMany({
    where: { tenantId: tenantIdFor(req), isAvailable: true },
    include: { category: true, product: true, ingredients: { include: { product: true } } },
    orderBy: [{ category: { sortOrder: "asc" } }, { name: "asc" }],
  });
  res.status(200).json({ items });
});

/** Adds a saleable café item, such as a hot latte or iced tea, to the POS menu. */
posRouter.post("/menu-items", async (req, res) => {
  const parsed = menuItemSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid menu item", details: parsed.error.flatten() });
    return;
  }

  const tenantId = tenantIdFor(req);
  if (parsed.data.productId) {
    const product = await prisma.product.findFirst({
      where: { id: parsed.data.productId, tenantId, isActive: true },
    });
    if (!product) {
      res.status(400).json({ error: "Choose an active inventory item belonging to this café" });
      return;
    }
  }

  const { category, productId, ...menuItemData } = parsed.data;
  const item = await prisma.menuItem.create({
    data: {
      ...menuItemData,
      tenant: { connect: { id: tenantId } },
      ...(productId ? { product: { connect: { id: productId } } } : {}),
      category: {
        connectOrCreate: {
          where: { tenantId_name: { tenantId, name: category } },
          create: { tenantId, name: category },
        },
      },
    },
    include: { category: true, product: true },
  });

  res.status(201).json({ item });
});

/** Use a signed quantity to receive stock (+) or record stock usage/waste (-). */
posRouter.post("/inventory/items/:id/adjust", async (req, res) => {
  const parsed = adjustmentSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "Invalid stock adjustment", details: parsed.error.flatten() });
    return;
  }

  const tenantId = tenantIdFor(req);
  // The conditional update prevents simultaneous requests from taking stock
  // below zero (a read-then-update check alone is vulnerable to a race).
  const minimumQuantity = parsed.data.quantity < 0 ? Math.abs(parsed.data.quantity) : undefined;
  const updated = await prisma.product.updateMany({
    where: {
      id: req.params.id,
      tenantId,
      ...(minimumQuantity === undefined ? {} : { quantity: { gte: minimumQuantity } }),
    },
    data: { quantity: { increment: parsed.data.quantity } },
  });

  if (updated.count === 0) {
    const exists = await prisma.product.findFirst({ where: { id: req.params.id, tenantId } });
    res.status(exists ? 400 : 404).json({
      error: exists ? "Stock cannot fall below zero" : "Inventory item not found",
    });
    return;
  }

  const item = await prisma.product.findUniqueOrThrow({ where: { id: req.params.id } });
  res.status(200).json({ item });
});
