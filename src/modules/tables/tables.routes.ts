import { Router } from "express";
import { Prisma, PosOrderStatus } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { withServedBy } from "../pos/pos.routes.js";

export const tablesRouter = Router();
tablesRouter.use(requireModule("POS"));

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalId = z.preprocess(blankToUndefined, z.string().trim().optional());

const createSchema = z.object({
  label: z.string().trim().min(1).max(30),
  area: optionalText(60),
  capacity: z.coerce.number().int().min(1).max(50).default(2),
  locationId: optionalId,
  isActive: z.boolean().default(true),
});
// locationId needs to distinguish "not sent, leave it" (undefined) from
// "clear it back to shared" (null) — the blanket optionalId helper collapses
// both to undefined, which Prisma then silently skips instead of unsetting.
const updateSchema = partialNoDefaults(createSchema).extend({ locationId: z.string().trim().min(1).nullable().optional() });

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const ACTIVE_ORDER_STATUSES: PosOrderStatus[] = ["OPEN", "PREPARING", "READY", "SERVED"];

const tableFields = {
  id: true,
  label: true,
  area: true,
  capacity: true,
  status: true,
  isActive: true,
  locationId: true,
  location: { select: { id: true, name: true } },
  createdAt: true,
  updatedAt: true,
  orders: {
    where: { status: { in: ACTIVE_ORDER_STATUSES } },
    select: {
      id: true,
      orderNumber: true,
      status: true,
      createdAt: true,
      createdBy: true,
      customer: { select: { firstName: true, lastName: true } },
      items: { select: { quantity: true } },
    },
    orderBy: { createdAt: "desc" as const },
  },
} as const;

type OrderWithCounts = { orders: { id: string; orderNumber: number; status: string; createdAt: Date; createdBy: string | null; customer: { firstName: string; lastName: string | null } | null; items: { quantity: number }[] }[] };

/** Enriches each active order with who placed it ("served by") and how many
 * items it holds, so the "choose an order" list on a busy table gives staff
 * enough to tell orders apart at a glance instead of just a bare number. */
async function withActiveOrders<T extends OrderWithCounts>(table: T) {
  const { orders, ...rest } = table;
  const activeOrders = await Promise.all(
    orders.map(async ({ items, ...order }) => ({
      ...(await withServedBy(order)),
      itemCount: items.reduce((sum, item) => sum + item.quantity, 0),
    })),
  );
  return { ...rest, activeOrders };
}

tablesRouter.get("/", async (req, res) => {
  const query = z.object({ locationId: optionalId }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid filters" }); return; }
  const tables = await prisma.table.findMany({
    where: { tenantId: tenantId(req), ...(query.data.locationId ? { OR: [{ locationId: null }, { locationId: query.data.locationId }] } : {}) },
    select: tableFields,
    orderBy: [{ area: "asc" }, { label: "asc" }],
  });
  res.json({ tables: await Promise.all(tables.map(withActiveOrders)) });
});

tablesRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid table", details: data.error.flatten() }); return; }
  try {
    const table = await prisma.table.create({ data: { tenantId: tenantId(req), ...data.data }, select: tableFields });
    res.status(201).json({ table: await withActiveOrders(table) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A table with this label already exists" }); return; }
    next(error);
  }
});

tablesRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid table", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const updated = await prisma.table.updateMany({ where: { id: req.params.id, tenantId: tid }, data: data.data });
    if (!updated.count) { res.status(404).json({ error: "Table not found" }); return; }
    const table = await prisma.table.findUniqueOrThrow({ where: { id: req.params.id }, select: tableFields });
    res.json({ table: await withActiveOrders(table) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A table with this label already exists" }); return; }
    next(error);
  }
});

tablesRouter.delete("/:id", async (req, res) => {
  const tid = tenantId(req);
  const existing = await prisma.table.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!existing) { res.status(404).json({ error: "Table not found" }); return; }
  if (existing.status === "OCCUPIED") { res.status(409).json({ error: "This table has an open order — settle or cancel it first" }); return; }
  await prisma.table.delete({ where: { id: existing.id } });
  res.status(204).send();
});
