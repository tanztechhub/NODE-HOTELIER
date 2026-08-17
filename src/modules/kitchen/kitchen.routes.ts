import { Router } from "express";

import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";

export const kitchenRouter = Router();
kitchenRouter.use(requireModule("KITCHEN"));
const tenantId = (req: { tenantId?: string }) => { if (!req.tenantId) throw new Error("Tenant context is required"); return req.tenantId; };

const orderInclude = {
  items: { include: {
    menuItem: { include: { category: true, product: true, ingredients: { include: { product: true } } } },
    addons: { include: { addon: true } },
  } },
} as const;

/** Live queue created by POS, enriched with menu and linked product recipes. */
kitchenRouter.get("/orders", async (req, res) => {
  const orders = await prisma.posOrder.findMany({ where: { tenantId: tenantId(req), status: { in: ["OPEN", "PREPARING"] } }, include: orderInclude, orderBy: { createdAt: "asc" } });
  res.json({ orders });
});

/** Claims a new ticket for preparation. */
kitchenRouter.patch("/orders/:id/start", async (req, res) => {
  const updated = await prisma.posOrder.updateMany({ where: { id: req.params.id, tenantId: tenantId(req), status: "OPEN" }, data: { status: "PREPARING" } });
  if (!updated.count) { res.status(404).json({ error: "New kitchen order not found" }); return; }
  res.json({ order: await prisma.posOrder.findUniqueOrThrow({ where: { id: req.params.id }, include: orderInclude }) });
});

/** Marks a prepared order ready and consumes its Products recipe from inventory. */
kitchenRouter.patch("/orders/:id/ready", async (req, res) => {
  const tid = tenantId(req);
  const activeOrder = await prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid, status: "PREPARING" }, include: orderInclude });
  if (!activeOrder) { res.status(404).json({ error: "Preparing kitchen order not found" }); return; }

  const requirements = new Map<string, { quantity: number; name: string; storeId: string }>();
  for (const orderItem of activeOrder.items) {
    const recipe = orderItem.menuItem.ingredients.length
      ? orderItem.menuItem.ingredients.map((ingredient) => ({ item: ingredient.product, quantity: Number(ingredient.quantity) }))
      : orderItem.menuItem.product ? [{ item: orderItem.menuItem.product, quantity: 1 }] : [];
    for (const ingredient of recipe) {
      const required = ingredient.quantity * orderItem.quantity;
      const current = requirements.get(ingredient.item.id);
      requirements.set(ingredient.item.id, { quantity: (current?.quantity ?? 0) + required, name: ingredient.item.name, storeId: ingredient.item.storeId });
    }
  }

  try {
    await prisma.$transaction(async (tx) => {
      for (const [productId, requirement] of requirements) {
        const stock = await tx.product.updateMany({ where: { id: productId, tenantId: tid, quantity: { gte: requirement.quantity } }, data: { quantity: { decrement: requirement.quantity } } });
        if (!stock.count) throw new Error(`Not enough ${requirement.name} in stock`);
        await tx.inventoryMovement.create({ data: { tenantId: tid, productId, storeId: requirement.storeId, type: "DISPATCH", quantity: -requirement.quantity, note: `Used for POS order #${activeOrder.orderNumber}`, performedBy: req.userId } });
      }
      await tx.posOrder.update({ where: { id: activeOrder.id }, data: { status: "READY", readyAt: new Date() } });
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not enough ")) { res.status(409).json({ error: error.message }); return; }
    throw error;
  }

  const order = await prisma.posOrder.findUniqueOrThrow({ where: { id: activeOrder.id }, include: orderInclude });
  res.json({ notification: { type: "ORDER_READY", message: `Order #${order.orderNumber} is ready to serve` }, order });
});

/** Product-backed menu and recipe snapshot used by the kitchen side panel. */
kitchenRouter.get("/menu-items", async (req, res) => {
  const items = await prisma.menuItem.findMany({ where: { tenantId: tenantId(req), isAvailable: true }, include: { category: true, product: true, ingredients: { include: { product: true } } }, orderBy: [{ category: { sortOrder: "asc" } }, { name: "asc" }] });
  res.json({ items });
});

kitchenRouter.get("/drink-offerings", async (req, res) => {
  const drinks = await prisma.menuItem.findMany({ where: { tenantId: tenantId(req), isAvailable: true }, select: { id: true, name: true, description: true, temperature: true, category: { select: { name: true } }, product: { select: { id: true, name: true, quantity: true, unit: true } }, ingredients: { include: { product: { select: { id: true, name: true, quantity: true, unit: true } } } } }, orderBy: [{ temperature: "asc" }, { name: "asc" }] });
  const offerings = { hot: drinks.filter((drink) => drink.temperature === "HOT"), cold: drinks.filter((drink) => drink.temperature === "COLD"), other: drinks.filter((drink) => drink.temperature === "OTHER") };
  res.json({ offerings, summary: { hot: offerings.hot.length, cold: offerings.cold.length, other: offerings.other.length } });
});
