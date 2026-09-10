import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";

import { requireModule, requireAdmin } from "../../middleware/tenantContext.js";
import { prisma } from "../../lib/prisma.js";
import { computeOrderFinancials } from "../../lib/orderTotals.js";
import { nextTransactionNo } from "../../lib/sequence.js";
import { resolveEffectiveLocation, employeeLocationId } from "../../lib/location.js";
import { recordStockMovement, InsufficientStockError } from "../../lib/stockLedger.js";

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

// reservationId is optional "remember this bar tab is for Room 12" — it
// stamps the checked-in stay onto the order so settlement can default to
// charging the folio, but it does NOT charge the folio now (a tab isn't
// paid until the guest is done, and they may still settle in cash).
// A single line the cashier is ringing up: a menu item, optionally a specific
// variant (size/option), and any chosen add-ons. Variant choice and add-on
// group rules are validated against the live menu in resolveMenuLines().
const orderLineSchema = z.object({
  menuItemId: z.string().cuid(),
  variantId: z.string().cuid().optional(),
  quantity: z.coerce.number().int().min(1).max(50),
  addons: z.array(z.object({ addonId: z.string().cuid(), quantity: z.coerce.number().int().min(1).max(20).default(1) })).default([]),
});
const orderSchema = z.object({ tableId: z.string().cuid().optional(), locationId: z.string().cuid().optional(), customerId: z.string().trim().min(1).optional(), reservationId: z.string().trim().min(1).optional(), notes: z.string().trim().max(500).optional(), discount: z.coerce.number().min(0).default(0), items: z.array(orderLineSchema).min(1) });
const addItemsSchema = z.object({ items: z.array(orderLineSchema).min(1) });

// Editing one existing line: any facet omitted keeps its current value.
const editItemSchema = z.object({
  variantId: z.string().cuid().nullable().optional(),
  quantity: z.coerce.number().int().min(1).max(50).optional(),
  addons: z.array(z.object({ addonId: z.string().cuid(), quantity: z.coerce.number().int().min(1).max(20).default(1) })).optional(),
});

type OrderLineInput = z.infer<typeof orderLineSchema>;

// What resolveMenuLines needs to price a line: the item's active variants
// and the product/recipe used later for stock deduction. Add-ons are a flat
// tenant catalog now — validated separately, not per item.
const menuLineInclude = {
  variants: { where: { isActive: true } },
  product: true,
  recipe: { include: { ingredients: { include: { product: true } } } },
} satisfies Prisma.MenuItemInclude;

type LineTaxSnapshot = {
  taxRate: Prisma.Decimal | null;
  taxMode: "INCLUSIVE" | "EXCLUSIVE" | null;
  taxTreatment: "STANDARD" | "ZERO_RATED" | "EXEMPT" | null;
};

type ResolvedLine = {
  menuItemId: string;
  variantId: string | undefined;
  quantity: number;
  unitPrice: Prisma.Decimal;
  addons: { addonId: string; quantity: number; unitPrice: Prisma.Decimal }[];
} & LineTaxSnapshot;

/** Validates a set of POS order lines against the current menu — item
 * availability, variant choice (required once an item has variants), and
 * that every chosen add-on is an active add-on for this tenant — and returns
 * each line with its resolved prices and tax snapshot, plus the menu items
 * (with product/recipe) for downstream stock maths. Throws { status: 400 }
 * on the first problem. */
async function resolveMenuLines(tid: string, lines: OrderLineInput[], taxDefaults: TaxDefaults | null) {
  const menuItemIds = [...new Set(lines.map((line) => line.menuItemId))];
  const addonIds = [...new Set(lines.flatMap((line) => line.addons.map((a) => a.addonId)))];
  const [menuItems, addons] = await Promise.all([
    prisma.menuItem.findMany({ where: { id: { in: menuItemIds }, tenantId: tid, isAvailable: true }, include: menuLineInclude }),
    addonIds.length
      ? prisma.addon.findMany({ where: { id: { in: addonIds }, tenantId: tid, isActive: true }, select: { id: true, price: true } })
      : Promise.resolve([]),
  ]);
  const byId = new Map(menuItems.map((item) => [item.id, item]));
  if (byId.size !== menuItemIds.length) {
    throw Object.assign(new Error("Every order item must be an available menu item from this café"), { status: 400 });
  }
  const priceByAddon = new Map(addons.map((a) => [a.id, a.price]));
  if (priceByAddon.size !== addonIds.length) {
    throw Object.assign(new Error("Every add-on must be an active add-on from this café"), { status: 400 });
  }

  const resolved: ResolvedLine[] = lines.map((line) => {
    const item = byId.get(line.menuItemId)!;

    // Variant — mandatory once the item defines any, and it must be one of
    // this item's own active variants. Its price replaces the base price.
    let variantId: string | undefined;
    let unitPrice = item.price;
    if (line.variantId) {
      const variant = item.variants.find((v) => v.id === line.variantId);
      if (!variant) throw Object.assign(new Error(`Choose a valid option for ${item.name}`), { status: 400 });
      variantId = variant.id;
      unitPrice = variant.price;
    } else if (item.variants.length > 0) {
      throw Object.assign(new Error(`Choose an option for ${item.name}`), { status: 400 });
    }

    if (line.addons.length > 0 && !item.allowsAddons) {
      throw Object.assign(new Error(`${item.name} doesn't take add-ons`), { status: 400 });
    }

    return {
      menuItemId: line.menuItemId,
      variantId,
      quantity: line.quantity,
      unitPrice,
      addons: line.addons.map((sel) => ({ addonId: sel.addonId, quantity: sel.quantity, unitPrice: priceByAddon.get(sel.addonId)! })),
      ...resolveLineTax(item, taxDefaults),
    };
  });

  return { lines: resolved, menuItemsById: byId };
}

/** Turns resolved lines into a Prisma `items.create` payload. */
function lineCreatePayload(lines: ResolvedLine[]): Prisma.PosOrderItemCreateWithoutOrderInput[] {
  return lines.map((line) => ({
    menuItemId: line.menuItemId,
    variantId: line.variantId,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    taxRate: line.taxRate,
    taxMode: line.taxMode,
    taxTreatment: line.taxTreatment,
    addons: { create: line.addons.map((addon) => ({ addonId: addon.addonId, quantity: addon.quantity, unitPrice: addon.unitPrice })) },
  }));
}

// Bill-to-room is decided at settlement, not order creation — a tab isn't
// paid until the customer is done, and they may not know or may change
// their mind about cash vs. room until then. "ROOM" resolves which
// checked-in stay to charge at that moment, same as a PAY resolves which
// payment method.
const paymentSchema = z.discriminatedUnion("method", [
  z.object({ method: z.literal("PAY"), paymentMethodId: z.string().trim().min(1), amount: z.coerce.number().positive(), reference: z.string().trim().max(120).optional() }),
  z.object({ method: z.literal("ROOM"), reservationId: z.string().trim().min(1), amount: z.coerce.number().positive() }),
]);

const retailOrderSchema = z.discriminatedUnion("channel", [
  z.object({
    channel: z.literal("PRODUCTS"),
    locationId: z.string().trim().min(1).optional(),
    customerId: z.string().trim().min(1).optional(),
    notes: z.string().trim().max(500).optional(),
    discount: z.coerce.number().min(0).default(0),
    items: z.array(z.object({ productId: z.string().trim().min(1), quantity: z.coerce.number().int().min(1).max(999) })).min(1),
  }),
  z.object({
    channel: z.literal("SERVICES"),
    locationId: z.string().trim().min(1).optional(),
    customerId: z.string().trim().min(1).optional(),
    notes: z.string().trim().max(500).optional(),
    discount: z.coerce.number().min(0).default(0),
    items: z.array(z.object({ serviceId: z.string().trim().min(1), quantity: z.coerce.number().int().min(1).max(999) })).min(1),
  }),
]);

async function resolvePaymentMethod(tid: string, paymentMethodId: string, reference: string | undefined) {
  const method = await prisma.paymentMethod.findFirst({ where: { id: paymentMethodId, tenantId: tid, isActive: true } });
  if (!method) throw Object.assign(new Error("Choose a valid, active payment method"), { status: 400 });
  if (method.requiresReference && !reference) throw Object.assign(new Error(`${method.name} requires a reference number`), { status: 400 });
  return method;
}

function tenantIdFor(request: { tenantId?: string }): string {
  if (!request.tenantId) throw new Error("Tenant context is required");
  return request.tenantId;
}

const orderInclude = {
  items: { include: {
    menuItem: { include: { product: true, recipe: { include: { ingredients: { include: { product: true } } } } } },
    variant: { select: { id: true, name: true } },
    product: { select: { id: true, name: true, unit: true } },
    service: { select: { id: true, name: true, unit: { select: { name: true } } } },
    addons: { include: { addon: true } },
  } },
  payments: { include: { paymentMethod: { select: { id: true, name: true, requiresReference: true } } } },
  table: true,
  location: true,
  customer: { select: { id: true, firstName: true, lastName: true, phone: true } },
  reservation: { select: { id: true, reservationNo: true, customerId: true, customer: { select: { firstName: true, lastName: true } }, room: { select: { number: true } } } },
} as const;

/** Validates an explicitly-chosen customerId belongs to this tenant — who a
 * sale is for is always optional (a quick anonymous cash sale shouldn't have
 * to stop and create a customer record), but when given it must be real. */
async function resolveCustomerId(tid: string, customerId: string | undefined): Promise<string | undefined> {
  if (!customerId) return undefined;
  const customer = await prisma.customer.findFirst({ where: { id: customerId, tenantId: tid }, select: { id: true } });
  if (!customer) throw Object.assign(new Error("Choose a customer from this property"), { status: 400 });
  return customer.id;
}

/** Resolves a reservation this order can be billed to: must belong to this
 * tenant, be checked in, and have an open folio to receive the charge.
 * Returns null when no reservationId was given (the normal case — most
 * sales are paid for directly, not billed to a room). */
async function resolveBillableReservation(tid: string, reservationId: string | undefined) {
  if (!reservationId) return null;
  const reservation = await prisma.reservation.findFirst({
    where: { id: reservationId, tenantId: tid, status: "CHECKED_IN" },
    include: { folio: true },
  });
  if (!reservation || !reservation.folio || reservation.folio.status !== "OPEN") {
    throw Object.assign(new Error("Choose a checked-in stay with an open folio to bill this to"), { status: 400 });
  }
  return reservation;
}

/** Charges a finalized sale to a guest's folio instead of collecting payment
 * directly — settled later alongside the room bill at checkout, the same
 * way a SERVICE or AD_HOC charge already is. No Transaction is written here:
 * a charge isn't a payment, the guest hasn't handed over money yet. */
async function chargeOrderToFolio(
  tx: Prisma.TransactionClient,
  tid: string,
  folioId: string,
  order: { id: string; orderNumber: number; channel: string },
  amount: number,
  req: { userId?: string },
) {
  if (amount <= 0) return;
  const channelLabel = order.channel === "FOOD" ? "Order" : order.channel === "PRODUCTS" ? "Retail sale" : "Service sale";
  await tx.folioLineItem.create({
    data: { tenantId: tid, folioId, source: "POS_ORDER", label: `${channelLabel} #${order.orderNumber}`, amount, quantity: 1, sourceRefId: order.id, createdBy: req.userId },
  });
}

async function taxSettingsFor(tid: string) {
  const profile = await prisma.businessProfile.findUnique({ where: { tenantId: tid }, select: { taxRate: true, taxMode: true, taxTreatment: true } });
  return profile ?? null;
}

type TaxDefaults = NonNullable<Awaited<ReturnType<typeof taxSettingsFor>>>;

/** The tax a POS line is sold under: the menu item's own override for any
 * facet it sets, else the tenant default. Snapshotted onto PosOrderItem so a
 * later change to either never re-taxes a historical order. */
function resolveLineTax(
  item: { taxRate: Prisma.Decimal | null; taxMode: "INCLUSIVE" | "EXCLUSIVE" | null; taxTreatment: "STANDARD" | "ZERO_RATED" | "EXEMPT" | null },
  fallback: TaxDefaults | null,
) {
  return {
    taxRate: item.taxRate ?? fallback?.taxRate ?? null,
    taxMode: item.taxMode ?? fallback?.taxMode ?? null,
    taxTreatment: item.taxTreatment ?? fallback?.taxTreatment ?? null,
  };
}

type FinancialOrder = Parameters<typeof computeOrderFinancials>[0] & { payments: { amount: Prisma.Decimal }[] };

/** Attaches the money breakdown (subtotal/discount/tax/total) plus the flat
 * total/paid fields older frontend callers already read. */
function withFinancials<T extends FinancialOrder>(order: T, tax: Awaited<ReturnType<typeof taxSettingsFor>>) {
  const financials = computeOrderFinancials(order, tax);
  const paid = order.payments.reduce((s, p) => s + Number(p.amount), 0);
  return { ...order, financials, total: financials.total, paid };
}

/** Frees a table back to AVAILABLE if it has no other active order. Call from inside the same transaction that finalized the order. */
async function releaseTableIfIdle(tx: Prisma.TransactionClient, tableId: string) {
  const stillActive = await tx.posOrder.findFirst({ where: { tableId, status: { in: ["OPEN", "PREPARING", "READY", "SERVED"] } } });
  if (!stillActive) await tx.table.updateMany({ where: { id: tableId }, data: { status: "AVAILABLE" } });
}

// A fixed-location employee only ever sees their own location's orders; a
// floating one (a manager) sees everything by default — unlike ringing up a
// live sale, browsing order history isn't blocked by an unclear location, so
// an optional ?locationId= is offered instead of forcing a pick. Orders
// record where they actually happened, so this is an exact match — not the
// "unallocated = everywhere" convention used for menu items/tables.
posRouter.get("/orders", async (req, res) => {
  const query = z.object({
    status: z.enum(["OPEN", "PREPARING", "READY", "SERVED", "COMPLETED", "CANCELLED", "PENDING_CANCELLATION"]).optional(),
    channel: z.enum(["FOOD", "PRODUCTS", "SERVICES"]).optional(),
    locationId: z.string().cuid().optional(),
  }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid filters" }); return; }
  const tid = tenantIdFor(req);
  const fixedLocationId = await employeeLocationId(tid, req.userId);
  const effectiveLocationId = fixedLocationId ?? query.data.locationId ?? null;
  const [orders, tax] = await Promise.all([
    prisma.posOrder.findMany({ where: { tenantId: tid, ...(query.data.status ? { status: query.data.status } : {}), ...(query.data.channel ? { channel: query.data.channel } : {}), ...(effectiveLocationId ? { locationId: effectiveLocationId } : {}) }, include: orderInclude, orderBy: { createdAt: "desc" } }),
    taxSettingsFor(tid),
  ]);
  res.status(200).json({ orders: orders.map((order) => withFinancials(order, tax)) });
});

/** POS notification queue: Kitchen places finished orders here for serving. */
posRouter.get("/orders/ready", async (req, res) => {
  const tid = tenantIdFor(req);
  const [orders, tax] = await Promise.all([
    prisma.posOrder.findMany({ where: { tenantId: tid, status: "READY" }, include: orderInclude, orderBy: { readyAt: "asc" } }),
    taxSettingsFor(tid),
  ]);
  res.status(200).json({ notifications: orders.map((order) => ({ type: "ORDER_READY", message: `Order #${order.orderNumber} is ready to serve`, order: withFinancials(order, tax) })) });
});

posRouter.post("/orders", async (req, res) => {
  const parsed = orderSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid order", details: parsed.error.flatten() }); return; }
  const tid = tenantIdFor(req);
  const tax = await taxSettingsFor(tid);
  let resolvedLines: ResolvedLine[];
  try {
    ({ lines: resolvedLines } = await resolveMenuLines(tid, parsed.data.items, tax));
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
  if (parsed.data.tableId) {
    const table = await prisma.table.findFirst({ where: { id: parsed.data.tableId, tenantId: tid, isActive: true } });
    if (!table) { res.status(400).json({ error: "Choose an active table from this property" }); return; }
    // A table can carry several separate, independently-billed orders at
    // once (a 6-seat table might have two couples each running their own
    // tab) — only a table that's actually out of service blocks a new one.
    if (table.status === "OUT_OF_SERVICE") { res.status(409).json({ error: "This table is out of service" }); return; }
  }

  const locationResult = await resolveEffectiveLocation(tid, req.userId, parsed.data.locationId);
  if ("error" in locationResult) { res.status(400).json({ error: locationResult.error }); return; }
  const { location } = locationResult;
  if (location && !location.canSellMenu) { res.status(409).json({ error: `${location.name} isn't set up to sell menu items` }); return; }
  const effectiveLocationId = location?.id ?? null;
  // Owner-controlled per location (Location.servesDirectly) — a bar or
  // bakery counter typically hands the item straight over with no prep step,
  // so the order skips OPEN/PREPARING/READY entirely and goes straight to
  // SERVED, exactly like a retail (Products/Services) sale already does.
  const instantServe = location?.servesDirectly === true;

  let customerId: string | undefined;
  let billToReservationId: string | undefined;
  try {
    customerId = await resolveCustomerId(tid, parsed.data.customerId);
    if (parsed.data.reservationId) {
      const reservation = await resolveBillableReservation(tid, parsed.data.reservationId);
      billToReservationId = reservation!.id;
      // A tab picked to a room adopts that guest as its customer unless one
      // was explicitly chosen — same rule the settlement ROOM branch uses.
      customerId = customerId ?? reservation!.customerId;
    }
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }

  try {
    const order = await prisma.$transaction(async (tx) => {
      const last = await tx.posOrder.findFirst({ where: { tenantId: tid }, orderBy: { orderNumber: "desc" }, select: { orderNumber: true } });
      const created = await tx.posOrder.create({
        data: {
          tenantId: tid,
          orderNumber: (last?.orderNumber ?? 0) + 1,
          tableId: parsed.data.tableId,
          locationId: effectiveLocationId,
          customerId,
          reservationId: billToReservationId,
          notes: parsed.data.notes,
          discount: parsed.data.discount,
          status: instantServe ? "SERVED" : "OPEN",
          servedAt: instantServe ? new Date() : undefined,
          items: { create: lineCreatePayload(resolvedLines) },
        },
        include: orderInclude,
      });
      if (parsed.data.tableId) {
        await tx.table.updateMany({ where: { id: parsed.data.tableId }, data: { status: "OCCUPIED" } });
      }
      if (instantServe) {
        const stockLocationId = await resolveStockLocationId(tid, effectiveLocationId);
        if (!stockLocationId) throw Object.assign(new Error("No location is configured to hold stock for this order"), { status: 400 });
        await deductStockForOrder(tx, tid, computeStockRequirements(created.items), stockLocationId, created.orderNumber, req);
      }
      return created;
    });
    res.status(201).json({ order: withFinancials(order, tax) });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not enough ")) { res.status(409).json({ error: error.message }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});

/** Adds more items to a still-open FOOD order — another round, more food —
 * before it's finally settled. Food/Bar only: Products/Services sales are
 * one-shot, created and settled together, with no "keep adding" moment. */
posRouter.post("/orders/:id/items", async (req, res) => {
  const parsed = addItemsSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid items", details: parsed.error.flatten() }); return; }
  const tid = tenantIdFor(req);
  const order = await prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid }, include: orderInclude });
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  if (order.channel !== "FOOD") { res.status(409).json({ error: "Only food/bar orders can have items added after the fact" }); return; }
  if (["COMPLETED", "CANCELLED"].includes(order.status)) { res.status(409).json({ error: "This order is already finalized — start a new one instead" }); return; }

  const tax = await taxSettingsFor(tid);
  let resolvedLines: ResolvedLine[];
  let menuItemsById: Awaited<ReturnType<typeof resolveMenuLines>>["menuItemsById"];
  try {
    ({ lines: resolvedLines, menuItemsById } = await resolveMenuLines(tid, parsed.data.items, tax));
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }

  // Same menu item, same variant, same set of add-ons is the *same line* —
  // bump its quantity instead of stacking a duplicate row on the bill. A
  // different variant or add-on selection stays a separate line.
  const lineKey = (variantId: string | null | undefined, addons: { addonId: string }[]) =>
    `${variantId ?? ""}::${addons.map((a) => a.addonId).sort().join("|")}`;

  try {
    const updated = await prisma.$transaction(async (tx) => {
      for (const line of resolvedLines) {
        const key = lineKey(line.variantId, line.addons);
        const existing = order.items.find((row) => row.menuItemId === line.menuItemId && lineKey(row.variantId, row.addons) === key);
        if (existing) {
          await tx.posOrderItem.update({ where: { id: existing.id }, data: { quantity: { increment: line.quantity } } });
          continue;
        }
        await tx.posOrderItem.create({
          data: {
            orderId: order.id,
            menuItemId: line.menuItemId,
            variantId: line.variantId,
            quantity: line.quantity,
            unitPrice: line.unitPrice,
            taxRate: line.taxRate,
            taxMode: line.taxMode,
            taxTreatment: line.taxTreatment,
            addons: { create: line.addons.map((addon) => ({ addonId: addon.addonId, quantity: addon.quantity, unitPrice: addon.unitPrice })) },
          },
        });
      }
      if (order.status === "SERVED") {
        const stockLocationId = await resolveStockLocationId(tid, order.locationId);
        if (!stockLocationId) throw Object.assign(new Error("No location is configured to hold stock for this order"), { status: 400 });
        // Only the newly added items need deducting — the rest were already
        // committed when the order was first served.
        const newItems = resolvedLines.map((line) => ({ quantity: line.quantity, menuItem: menuItemsById.get(line.menuItemId)! }));
        await deductStockForOrder(tx, tid, computeStockRequirements(newItems), stockLocationId, order.orderNumber, req);
      }
      return tx.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
    });
    res.status(201).json({ order: withFinancials(updated, tax) });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not enough ")) { res.status(409).json({ error: error.message }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});

/** Reconciles stock when a line on an already-SERVED order changes: pushes
 * out the extra where consumption went up, returns stock where it went down.
 * Only quantity affects this — a variant or add-on swap doesn't change the
 * recipe. Throws "Not enough X" (→ 409) if a top-up can't be covered. */
async function applyStockDelta(
  tx: Prisma.TransactionClient,
  tid: string,
  locationId: string,
  before: Map<string, { quantity: number; name: string }>,
  after: Map<string, { quantity: number; name: string }>,
  orderNumber: number,
  req: { userId?: string },
) {
  const productIds = new Set([...before.keys(), ...after.keys()]);
  for (const productId of productIds) {
    const b = before.get(productId);
    const a = after.get(productId);
    const name = a?.name ?? b?.name ?? "stock";
    const delta = (a?.quantity ?? 0) - (b?.quantity ?? 0);
    if (delta === 0) continue;
    try {
      await recordStockMovement(tx, {
        tenantId: tid, productId, locationId,
        type: delta > 0 ? "SALE" : "RETURN",
        quantity: -delta,
        note: `POS order #${orderNumber} line ${delta > 0 ? "increased" : "reduced"}`,
        sourceType: "POS_ORDER", sourceRefId: String(orderNumber),
        performedBy: req.userId ?? null, label: name,
      });
    } catch (error) {
      if (error instanceof InsufficientStockError) throw new Error(`Not enough ${name} at this location`);
      throw error;
    }
  }
}

/** Edits one line on a still-open order — swap the size/variant, add or drop
 * add-ons, change the quantity. Menu-item lines only. Re-validates and
 * re-prices against the current menu (and re-snapshots its tax), and on a
 * serve-now order reconciles the stock difference. */
posRouter.patch("/orders/:id/items/:itemId", async (req, res) => {
  const parsed = editItemSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid change", details: parsed.error.flatten() }); return; }
  const tid = tenantIdFor(req);
  const order = await prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid }, include: orderInclude });
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  if (order.channel !== "FOOD") { res.status(409).json({ error: "Only food/bar order lines can be edited here" }); return; }
  if (["COMPLETED", "CANCELLED"].includes(order.status)) { res.status(409).json({ error: "This order is finalized — it can't be changed" }); return; }
  const existing = order.items.find((row) => row.id === req.params.itemId);
  if (!existing) { res.status(404).json({ error: "That line isn't on this order" }); return; }
  if (!existing.menuItemId) { res.status(409).json({ error: "Only menu-item lines can be edited" }); return; }

  const desired: OrderLineInput = {
    menuItemId: existing.menuItemId,
    variantId: ("variantId" in parsed.data ? parsed.data.variantId : existing.variantId) ?? undefined,
    quantity: parsed.data.quantity ?? existing.quantity,
    addons: parsed.data.addons ?? existing.addons.map((a) => ({ addonId: a.addonId, quantity: a.quantity })),
  };

  const tax = await taxSettingsFor(tid);
  let resolved: ResolvedLine;
  let menuItemsById: Awaited<ReturnType<typeof resolveMenuLines>>["menuItemsById"];
  try {
    const out = await resolveMenuLines(tid, [desired], tax);
    resolved = out.lines[0];
    menuItemsById = out.menuItemsById;
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }

  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (order.status === "SERVED") {
        const stockLocationId = await resolveStockLocationId(tid, order.locationId);
        if (!stockLocationId) throw Object.assign(new Error("No location is configured to hold stock for this order"), { status: 400 });
        const mi = menuItemsById.get(existing.menuItemId!)!;
        const before = computeStockRequirements([{ quantity: existing.quantity, menuItem: mi }]);
        const after = computeStockRequirements([{ quantity: resolved.quantity, menuItem: mi }]);
        await applyStockDelta(tx, tid, stockLocationId, before, after, order.orderNumber, req);
      }
      await tx.posOrderItemAddon.deleteMany({ where: { orderItemId: existing.id } });
      await tx.posOrderItem.update({
        where: { id: existing.id },
        data: {
          variantId: resolved.variantId ?? null,
          quantity: resolved.quantity,
          unitPrice: resolved.unitPrice,
          taxRate: resolved.taxRate,
          taxMode: resolved.taxMode,
          taxTreatment: resolved.taxTreatment,
          addons: { create: resolved.addons.map((addon) => ({ addonId: addon.addonId, quantity: addon.quantity, unitPrice: addon.unitPrice })) },
        },
      });
      return tx.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
    });
    res.status(200).json({ order: withFinancials(updated, tax) });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not enough ")) { res.status(409).json({ error: error.message }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});

/** Removes one line from a still-open order. Returns its stock on a serve-now
 * order. An order can't be emptied this way — cancel it instead. */
posRouter.delete("/orders/:id/items/:itemId", async (req, res) => {
  const tid = tenantIdFor(req);
  const order = await prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid }, include: orderInclude });
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  if (order.channel !== "FOOD") { res.status(409).json({ error: "Only food/bar order lines can be edited here" }); return; }
  if (["COMPLETED", "CANCELLED"].includes(order.status)) { res.status(409).json({ error: "This order is finalized — it can't be changed" }); return; }
  const existing = order.items.find((row) => row.id === req.params.itemId);
  if (!existing) { res.status(404).json({ error: "That line isn't on this order" }); return; }
  if (order.items.length <= 1) { res.status(409).json({ error: "Cancel the order instead of removing its only line" }); return; }

  const tax = await taxSettingsFor(tid);
  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (order.status === "SERVED" && existing.menuItem) {
        const stockLocationId = await resolveStockLocationId(tid, order.locationId);
        if (!stockLocationId) throw Object.assign(new Error("No location is configured to hold stock for this order"), { status: 400 });
        const before = computeStockRequirements([{ quantity: existing.quantity, menuItem: existing.menuItem }]);
        await applyStockDelta(tx, tid, stockLocationId, before, new Map(), order.orderNumber, req);
      }
      await tx.posOrderItem.delete({ where: { id: existing.id } });
      return tx.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
    });
    res.status(200).json({ order: withFinancials(updated, tax) });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not enough ")) { res.status(409).json({ error: error.message }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});

/** Falls back to the tenant's warehouse (type STORE) when an order has no
 * location of its own — e.g. a property that isn't using locations at all. */
async function resolveStockLocationId(tid: string, orderLocationId: string | null): Promise<string | null> {
  if (orderLocationId) return orderLocationId;
  const store = await prisma.location.findFirst({ where: { tenantId: tid, type: "STORE" }, orderBy: { createdAt: "asc" }, select: { id: true } });
  return store?.id ?? null;
}

type OrderItemForStock = {
  quantity: number;
  menuItem: {
    product: { id: string; name: string } | null;
    recipe: { ingredients: { product: { id: string; name: string }; quantity: Prisma.Decimal | number }[] } | null;
  } | null;
};

/** Totals up how much of each product a set of order items actually needs —
 * a recipe's fractional ingredients if the menu item has one, else 1 unit of
 * its directly-linked product, matching how a whole-bottle bar item works. */
function computeStockRequirements(items: OrderItemForStock[]): Map<string, { quantity: number; name: string }> {
  const requirements = new Map<string, { quantity: number; name: string }>();
  for (const orderItem of items) {
    if (!orderItem.menuItem) continue;
    const ingredients = orderItem.menuItem.recipe?.ingredients.length
      ? orderItem.menuItem.recipe.ingredients.map((ingredient) => ({ item: ingredient.product, quantity: Number(ingredient.quantity) }))
      : orderItem.menuItem.product ? [{ item: orderItem.menuItem.product, quantity: 1 }] : [];
    for (const ingredient of ingredients) {
      const required = ingredient.quantity * orderItem.quantity;
      const current = requirements.get(ingredient.item.id);
      requirements.set(ingredient.item.id, { quantity: (current?.quantity ?? 0) + required, name: ingredient.item.name });
    }
  }
  return requirements;
}

/** Decrements ProductStock for each requirement and logs a matching DISPATCH
 * movement — the actual moment ingredients leave the building. Throws (never
 * responds directly) so callers can shape their own error response. */
async function deductStockForOrder(
  tx: Prisma.TransactionClient,
  tid: string,
  requirements: Map<string, { quantity: number; name: string }>,
  locationId: string,
  orderNumber: number,
  req: { userId?: string },
) {
  for (const [productId, requirement] of requirements) {
    try {
      await recordStockMovement(tx, {
        tenantId: tid, productId, locationId, type: "SALE", quantity: -requirement.quantity,
        note: `Used for POS order #${orderNumber}`, sourceType: "POS_ORDER", sourceRefId: String(orderNumber),
        performedBy: req.userId ?? null, label: requirement.name,
      });
    } catch (error) {
      if (error instanceof InsufficientStockError) throw new Error(`Not enough ${requirement.name} at this location — transfer more stock in`);
      throw error;
    }
  }
}

/** Waiter delivers the food — this is the point the ingredients are actually
 * gone, consumed from the order's own location's stock. Order stays open on
 * the table's tab until it's paid. */
posRouter.patch("/orders/:id/serve", async (req, res) => {
  const tid = tenantIdFor(req);
  const activeOrder = await prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid, status: "READY" }, include: orderInclude });
  if (!activeOrder) { res.status(404).json({ error: "Ready order not found" }); return; }

  const stockLocationId = await resolveStockLocationId(tid, activeOrder.locationId);
  if (!stockLocationId) { res.status(400).json({ error: "No location is configured to hold stock for this order" }); return; }

  const tax = await taxSettingsFor(tid);
  const requirements = computeStockRequirements(activeOrder.items);

  try {
    await prisma.$transaction(async (tx) => {
      await deductStockForOrder(tx, tid, requirements, stockLocationId, activeOrder.orderNumber, req);
      await tx.posOrder.update({ where: { id: activeOrder.id }, data: { status: "SERVED", servedAt: new Date() } });
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Not enough ")) { res.status(409).json({ error: error.message }); return; }
    throw error;
  }

  res.status(200).json({ order: withFinancials(await prisma.posOrder.findUniqueOrThrow({ where: { id: activeOrder.id }, include: orderInclude }), tax) });
});

const cancelRequestSchema = z.object({ reason: z.string().trim().min(3, "Give a reason").max(500) });
const rejectCancelSchema = z.object({ note: z.string().trim().max(500).optional() });

/** A waiter requests a cancellation — every cancel needs admin approval, so
 * this just parks the order in PENDING_CANCELLATION with a reason. The table
 * stays held and the order stays off the Active tab until an admin decides. */
posRouter.patch("/orders/:id/cancel", async (req, res) => {
  const parsed = cancelRequestSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.issues[0]?.message ?? "Invalid request", details: parsed.error.flatten() }); return; }
  const tid = tenantIdFor(req);
  const existing = await prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!existing) { res.status(404).json({ error: "Order not found" }); return; }
  if (existing.status === "PENDING_CANCELLATION") { res.status(409).json({ error: "This order is already waiting for a cancellation decision" }); return; }
  if (["COMPLETED", "CANCELLED"].includes(existing.status)) { res.status(409).json({ error: "This order is finalized and can't be cancelled" }); return; }
  const updated = await prisma.posOrder.update({
    where: { id: existing.id },
    data: {
      status: "PENDING_CANCELLATION",
      statusBeforeCancel: existing.status,
      cancelReason: parsed.data.reason,
      cancelRequestedBy: req.userId ?? null,
      cancelRequestedAt: new Date(),
      cancelDecidedBy: null,
      cancelDecidedAt: null,
      cancelDecisionNote: null,
    },
    include: orderInclude,
  });
  const tax = await taxSettingsFor(tid);
  res.status(200).json({ order: withFinancials(updated, tax) });
});

/** Admin approves a pending cancellation → CANCELLED. Frees the table, and
 * for an order that had already been served, returns its stock. Blocked if
 * the order has taken any payment (that needs a manual refund first). */
posRouter.post("/orders/:id/cancel/approve", requireAdmin, async (req, res) => {
  const id = req.params.id as string;
  const tid = tenantIdFor(req);
  const order = await prisma.posOrder.findFirst({ where: { id, tenantId: tid }, include: orderInclude });
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  if (order.status !== "PENDING_CANCELLATION") { res.status(409).json({ error: "This order isn't waiting for a cancellation decision" }); return; }
  if (order.payments.length > 0) { res.status(409).json({ error: "This order has recorded payments — refund those before cancelling it" }); return; }
  try {
    const updated = await prisma.$transaction(async (tx) => {
      if (order.statusBeforeCancel === "SERVED") {
        const stockLocationId = await resolveStockLocationId(tid, order.locationId);
        if (stockLocationId) {
          const req0 = computeStockRequirements(order.items);
          await applyStockDelta(tx, tid, stockLocationId, req0, new Map(), order.orderNumber, req);
        }
      }
      await tx.posOrder.update({ where: { id: order.id }, data: { status: "CANCELLED", cancelDecidedBy: req.userId ?? null, cancelDecidedAt: new Date() } });
      if (order.tableId) await releaseTableIfIdle(tx, order.tableId);
      return tx.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
    });
    const tax = await taxSettingsFor(tid);
    res.status(200).json({ order: withFinancials(updated, tax) });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});

/** Admin rejects a pending cancellation → the order returns to whatever
 * status it was in before the request. The reason and the decision note are
 * kept for the record. */
posRouter.post("/orders/:id/cancel/reject", requireAdmin, async (req, res) => {
  const id = req.params.id as string;
  const parsed = rejectCancelSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ error: "Invalid request", details: parsed.error.flatten() }); return; }
  const tid = tenantIdFor(req);
  const order = await prisma.posOrder.findFirst({ where: { id, tenantId: tid } });
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  if (order.status !== "PENDING_CANCELLATION") { res.status(409).json({ error: "This order isn't waiting for a cancellation decision" }); return; }
  const updated = await prisma.posOrder.update({
    where: { id: order.id },
    data: {
      status: order.statusBeforeCancel ?? "OPEN",
      statusBeforeCancel: null,
      cancelDecidedBy: req.userId ?? null,
      cancelDecidedAt: new Date(),
      cancelDecisionNote: parsed.data.note ?? null,
    },
    include: orderInclude,
  });
  const tax = await taxSettingsFor(tid);
  res.status(200).json({ order: withFinancials(updated, tax) });
});

/** Settles a served order's bill — cash/card/etc. now, or charged to a
 * checked-in guest's room (decided here, not at order creation, since staff
 * often don't know or may change their mind about that until the customer
 * is actually ready to settle). Splits are fine either way — several partial
 * payments, or a mix of cash and a room charge, are both allowed. Completes
 * and frees the table once fully covered. */
posRouter.post("/orders/:id/payments", async (req, res) => {
  const parsed = paymentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid payment", details: parsed.error.flatten() }); return; }
  const tid = tenantIdFor(req);
  const [order, tax] = await Promise.all([
    prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid }, include: orderInclude }),
    taxSettingsFor(tid),
  ]);
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  if (order.status !== "SERVED") { res.status(409).json({ error: "The order must be served before it can be paid" }); return; }
  const { total } = computeOrderFinancials(order, tax);
  const alreadyPaid = order.payments.reduce((s, p) => s + Number(p.amount), 0);
  const remaining = Math.round((total - alreadyPaid) * 100) / 100;
  if (parsed.data.amount > remaining + 0.01) { res.status(400).json({ error: `Amount exceeds the remaining balance of ${remaining.toFixed(2)}` }); return; }

  try {
    let updatedOrder;
    const data = parsed.data;
    if (data.method === "ROOM") {
      const reservation = await resolveBillableReservation(tid, data.reservationId);
      const roomChargeMethod = await prisma.paymentMethod.findFirst({ where: { tenantId: tid, code: "ROOM_CHARGE" } });
      if (!roomChargeMethod) throw Object.assign(new Error("Room charge isn't set up for this property"), { status: 500 });
      updatedOrder = await prisma.$transaction(async (tx) => {
        await tx.payment.create({ data: { tenantId: tid, orderId: order.id, paymentMethodId: roomChargeMethod.id, amount: data.amount, reference: reservation!.reservationNo, receivedBy: req.userId } });
        await chargeOrderToFolio(tx, tid, reservation!.folio!.id, order, data.amount, req);
        await tx.posOrder.update({ where: { id: order.id }, data: { reservationId: order.reservationId ?? reservation!.id, customerId: order.customerId ?? reservation!.customerId } });
        const paidSoFar = alreadyPaid + data.amount;
        if (paidSoFar >= total - 0.01) {
          await tx.posOrder.update({ where: { id: order.id }, data: { status: "COMPLETED" } });
          if (order.tableId) await releaseTableIfIdle(tx, order.tableId);
        }
        return tx.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
      });
    } else {
      await resolvePaymentMethod(tid, data.paymentMethodId, data.reference);
      const transactionNo = await nextTransactionNo(tid);
      updatedOrder = await prisma.$transaction(async (tx) => {
        const payment = await tx.payment.create({ data: { tenantId: tid, orderId: order.id, paymentMethodId: data.paymentMethodId, amount: data.amount, reference: data.reference, receivedBy: req.userId } });
        await tx.transaction.create({
          data: {
            tenantId: tid,
            transactionNo,
            direction: "IN",
            source: "POS_SALE",
            amount: data.amount,
            paymentMethodId: data.paymentMethodId,
            reference: data.reference,
            customerId: order.customerId ?? order.reservation?.customerId ?? null,
            locationId: order.locationId,
            employeeId: req.userId,
            description: `POS order #${order.orderNumber} payment`,
            sourceRefId: payment.id,
          },
        });
        const paidSoFar = alreadyPaid + data.amount;
        if (paidSoFar >= total - 0.01) {
          await tx.posOrder.update({ where: { id: order.id }, data: { status: "COMPLETED" } });
          if (order.tableId) await releaseTableIfIdle(tx, order.tableId);
        }
        return tx.posOrder.findUniqueOrThrow({ where: { id: order.id }, include: orderInclude });
      });
    }
    res.status(201).json({ order: withFinancials(updatedOrder, tax) });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});

posRouter.get("/orders/:id", async (req, res) => {
  const tid = tenantIdFor(req);
  const [order, tax] = await Promise.all([
    prisma.posOrder.findFirst({ where: { id: req.params.id, tenantId: tid }, include: orderInclude }),
    taxSettingsFor(tid),
  ]);
  if (!order) { res.status(404).json({ error: "Order not found" }); return; }
  res.status(200).json({ order: withFinancials(order, tax) });
});

/** The full active add-on catalog for the checkout add-on picker, each with
 * its menu category so the client can filter. Managed via /api/addons. */
posRouter.get("/addons", async (req, res) => res.json({
  addons: await prisma.addon.findMany({
    where: { tenantId: tenantIdFor(req), isActive: true },
    select: { id: true, name: true, description: true, price: true, imageUrl: true, menuCategoryId: true, menuCategory: { select: { id: true, name: true } } },
    orderBy: [{ menuCategory: { name: "asc" } }, { name: "asc" }],
  }),
}));

/** Returns the café-wide POS policy for this tenant. */
posRouter.get("/settings", async (req, res) => {
  const settings = await prisma.cafeSettings.findUnique({ where: { tenantId: tenantIdFor(req) } });
  res.status(200).json({ settings });
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

/** Lists the café items the cashier can add to an order. Managed (create/edit/delete) via /menu/items.
 * Location-scoped: a fixed-location employee always sees their own location's
 * menu; an unassigned employee sees only unallocated items until they pass
 * ?locationId= (the frontend should prompt them to pick one). Properties
 * that have never created a Location see everything, unfiltered. */
posRouter.get("/menu-items", async (req, res) => {
  const tid = tenantIdFor(req);
  const query = z.object({ locationId: z.string().cuid().optional() }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid filters" }); return; }

  const [fixedLocationId, locationCount, taxDefaults] = await Promise.all([
    employeeLocationId(tid, req.userId),
    prisma.location.count({ where: { tenantId: tid } }),
    taxSettingsFor(tid),
  ]);
  const effectiveLocationId = fixedLocationId ?? query.data.locationId ?? null;

  const where: Prisma.MenuItemWhereInput = {
    tenantId: tid,
    isAvailable: true,
    ...(locationCount > 0 ? { OR: [{ locations: { none: {} } }, ...(effectiveLocationId ? [{ locations: { some: { id: effectiveLocationId } } }] : [])] } : {}),
  };

  const rows = await prisma.menuItem.findMany({
    where,
    include: {
      menuCategory: true,
      product: true,
      locations: { select: { id: true, name: true } },
      recipe: { include: { ingredients: { include: { product: true } } } },
      variants: { where: { isActive: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { id: true, name: true, price: true, sku: true } },
    },
    orderBy: [{ menuCategory: { sortOrder: "asc" } }, { sortOrder: "asc" }, { name: "asc" }],
  });
  // The client still reads `.category` — keep that shape, sourced from the
  // menu's own category table now. Add-ons come from GET /pos/addons (a flat
  // catalog), not per item.
  const items = rows.map(({ menuCategory, taxRate, taxMode, taxTreatment, ...item }) => ({
    ...item,
    category: menuCategory,
    // Resolved effective tax (item override else tenant default) so the cart
    // can show a correct preview. The server re-resolves and snapshots this
    // on order create — the client value is never trusted for money.
    taxRate: taxRate ?? taxDefaults?.taxRate ?? null,
    taxMode: taxMode ?? taxDefaults?.taxMode ?? null,
    taxTreatment: taxTreatment ?? taxDefaults?.taxTreatment ?? null,
  }));
  res.status(200).json({ items });
});

/** Lists the products the cashier can add to a retail sale at their location.
 * A location "sells" a product iff it currently has stock there — no
 * separate allocation flag, same design as the rest of the stock ledger. */
posRouter.get("/product-items", async (req, res) => {
  const tid = tenantIdFor(req);
  const query = z.object({ locationId: z.string().cuid().optional() }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid filters" }); return; }
  const fixedLocationId = await employeeLocationId(tid, req.userId);
  const effectiveLocationId = fixedLocationId ?? query.data.locationId ?? null;
  if (!effectiveLocationId) { res.status(200).json({ items: [] }); return; }

  const items = await prisma.product.findMany({
    where: { tenantId: tid, isActive: true, sellingPrice: { not: null }, stocks: { some: { locationId: effectiveLocationId, quantity: { gt: 0 } } } },
    include: { category: true, stocks: { where: { locationId: effectiveLocationId }, select: { quantity: true } } },
    orderBy: { name: "asc" },
  });
  res.status(200).json({ items: items.map((item) => ({ ...item, availableQuantity: item.stocks[0]?.quantity ?? 0 })) });
});

/** Lists the services the cashier can add to a sale at their location.
 * Same unallocated-means-everywhere convention as menu items. */
posRouter.get("/service-items", async (req, res) => {
  const tid = tenantIdFor(req);
  const query = z.object({ locationId: z.string().cuid().optional() }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid filters" }); return; }
  const [fixedLocationId, locationCount] = await Promise.all([
    employeeLocationId(tid, req.userId),
    prisma.location.count({ where: { tenantId: tid } }),
  ]);
  const effectiveLocationId = fixedLocationId ?? query.data.locationId ?? null;

  const where: Prisma.ServiceWhereInput = {
    tenantId: tid,
    isActive: true,
    ...(locationCount > 0 ? { OR: [{ locations: { none: {} } }, ...(effectiveLocationId ? [{ locations: { some: { id: effectiveLocationId } } }] : [])] } : {}),
  };
  const items = await prisma.service.findMany({
    where,
    include: { category: true, unit: true, locations: { select: { id: true, name: true } } },
    orderBy: { name: "asc" },
  });
  res.status(200).json({ items });
});

/** Rings up a retail (Products) or service sale. Neither has a kitchen step,
 * so the order is created directly as SERVED — payment is taken immediately
 * after via the same POST /orders/:id/payments used for food. */
posRouter.post("/retail-orders", async (req, res) => {
  const parsed = retailOrderSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid order", details: parsed.error.flatten() }); return; }
  const tid = tenantIdFor(req);

  const locationResult = await resolveEffectiveLocation(tid, req.userId, parsed.data.locationId);
  if ("error" in locationResult) { res.status(400).json({ error: locationResult.error }); return; }
  const { location } = locationResult;
  const channel = parsed.data.channel;
  if (location && channel === "PRODUCTS" && !location.canSellProducts) { res.status(409).json({ error: `${location.name} isn't set up to sell products` }); return; }
  if (location && channel === "SERVICES" && !location.canSellServices) { res.status(409).json({ error: `${location.name} isn't set up to sell services` }); return; }
  const effectiveLocationId = location?.id ?? null;

  let customerId: string | undefined;
  try {
    customerId = await resolveCustomerId(tid, parsed.data.customerId);
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
  const tax = await taxSettingsFor(tid);
  // Retail lines carry the tenant's default tax treatment as their snapshot,
  // the same way a menu line carries its own — keeps receipts and the tax
  // breakdown complete across every channel.
  const retailLineTax = { taxRate: tax?.taxRate ?? null, taxMode: tax?.taxMode ?? null, taxTreatment: tax?.taxTreatment ?? null };

  try {
    const order = await prisma.$transaction(async (tx) => {
      let itemsCreate: Prisma.PosOrderItemCreateWithoutOrderInput[];
      const productNames = new Map<string, string>();

      if (channel === "PRODUCTS") {
        if (!effectiveLocationId) throw Object.assign(new Error("Choose which location this sale is for"), { status: 400 });
        const productIds = parsed.data.items.map((item) => item.productId);
        const products = await tx.product.findMany({ where: { id: { in: productIds }, tenantId: tid, isActive: true, sellingPrice: { not: null } } });
        if (products.length !== new Set(productIds).size) throw Object.assign(new Error("Every item must be an active, sellable product from this property"), { status: 400 });
        for (const p of products) productNames.set(p.id, p.name);
        const prices = new Map(products.map((p) => [p.id, p.sellingPrice!]));
        itemsCreate = parsed.data.items.map((item) => ({ productId: item.productId, quantity: item.quantity, unitPrice: prices.get(item.productId)!, ...retailLineTax }));
      } else {
        const serviceIds = parsed.data.items.map((item) => item.serviceId);
        const services = await tx.service.findMany({ where: { id: { in: serviceIds }, tenantId: tid, isActive: true } });
        if (services.length !== new Set(serviceIds).size) throw Object.assign(new Error("Every item must be an active service from this property"), { status: 400 });
        const prices = new Map(services.map((s) => [s.id, s.price]));
        itemsCreate = parsed.data.items.map((item) => ({ serviceId: item.serviceId, quantity: item.quantity, unitPrice: prices.get(item.serviceId)!, ...retailLineTax }));
      }

      const last = await tx.posOrder.findFirst({ where: { tenantId: tid }, orderBy: { orderNumber: "desc" }, select: { orderNumber: true } });
      const created = await tx.posOrder.create({
        data: {
          tenantId: tid,
          orderNumber: (last?.orderNumber ?? 0) + 1,
          channel,
          status: "SERVED",
          servedAt: new Date(),
          locationId: effectiveLocationId,
          customerId,
          notes: parsed.data.notes,
          discount: parsed.data.discount,
          items: { create: itemsCreate },
        },
        include: orderInclude,
      });

      if (channel === "PRODUCTS") {
        for (const item of parsed.data.items) {
          try {
            await recordStockMovement(tx, {
              tenantId: tid, productId: item.productId, locationId: effectiveLocationId!, type: "SALE",
              quantity: -item.quantity, note: `Sold — POS order #${created.orderNumber}`,
              sourceType: "POS_ORDER", sourceRefId: created.id, performedBy: req.userId ?? null,
              label: productNames.get(item.productId) ?? "stock",
            });
          } catch (error) {
            if (error instanceof InsufficientStockError) throw Object.assign(new Error(`Not enough ${error.label} at this location`), { status: 409 });
            throw error;
          }
        }
      }
      return created;
    });
    res.status(201).json({ order: withFinancials(order, tax) });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    throw error;
  }
});

