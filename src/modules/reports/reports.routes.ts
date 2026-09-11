import { Router } from "express";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { computeOrderFinancials } from "../../lib/orderTotals.js";
import { taxSettingsFor } from "../pos/pos.routes.js";
import { STOCK_MOVEMENT_TYPES } from "../stock-ledger/stock-ledger.routes.js";

export const reportsRouter = Router();
reportsRouter.use(requireModule("REPORTS"));

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

// Local calendar date, not UTC — "from"/"to" are parsed as local midnight
// below, so the default must agree with that or the window silently shifts.
function localIsoToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function dayBounds(from?: string, to?: string) {
  const today = localIsoToday();
  const start = new Date(`${from ?? today}T00:00:00.000`);
  const end = new Date(`${to ?? from ?? today}T23:59:59.999`);
  return { start, end };
}

/** Till reconciliation: money actually collected in the window (by payment date),
 * plus what's still owed on served-but-unpaid orders as of now. */
reportsRouter.get("/sales", async (req, res) => {
  const query = z.object({ from: isoDate.optional(), to: isoDate.optional() }).safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid date range", details: query.error.flatten() }); return; }
  const tid = tenantId(req);
  const { start, end } = dayBounds(query.data.from, query.data.to);

  const [payments, servedOrders, completedOrders, tax] = await Promise.all([
    prisma.payment.findMany({ where: { tenantId: tid, createdAt: { gte: start, lte: end } }, include: { paymentMethod: { select: { name: true } } }, orderBy: { createdAt: "desc" } }),
    prisma.posOrder.findMany({ where: { tenantId: tid, status: "SERVED" }, include: { items: { include: { addons: true } }, payments: true, table: true } }),
    prisma.posOrder.findMany({
      where: { tenantId: tid, status: "COMPLETED", updatedAt: { gte: start, lte: end } },
      include: { items: { include: { menuItem: true, addons: { include: { addon: true } } } }, payments: true, table: true },
      orderBy: { updatedAt: "desc" },
    }),
    prisma.businessProfile.findUnique({ where: { tenantId: tid }, select: { taxRate: true, taxMode: true, taxTreatment: true } }),
  ]);

  const orderTotal = (order: Parameters<typeof computeOrderFinancials>[0]) => computeOrderFinancials(order, tax).total;

  const totalRevenue = payments.reduce((s, p) => s + Number(p.amount), 0);

  const byMethodMap = new Map<string, { count: number; total: number }>();
  for (const p of payments) {
    const name = p.paymentMethod.name;
    const bucket = byMethodMap.get(name) ?? { count: 0, total: 0 };
    bucket.count += 1;
    bucket.total += Number(p.amount);
    byMethodMap.set(name, bucket);
  }
  const byMethod = [...byMethodMap.entries()].map(([method, v]) => ({ method, ...v })).sort((a, b) => b.total - a.total);

  const cashierIds = [...new Set(payments.map((p) => p.receivedBy).filter((id): id is string => Boolean(id)))];
  const cashiers = cashierIds.length ? await prisma.employee.findMany({ where: { id: { in: cashierIds } }, select: { id: true, firstName: true, lastName: true } }) : [];
  const cashierName = new Map(cashiers.map((c) => [c.id, `${c.firstName} ${c.lastName}`.trim()]));
  const byCashierMap = new Map<string, { name: string; count: number; total: number }>();
  for (const p of payments) {
    const key = p.receivedBy ?? "unknown";
    const bucket = byCashierMap.get(key) ?? { name: p.receivedBy ? cashierName.get(p.receivedBy) ?? "Unknown" : "Unattributed", count: 0, total: 0 };
    bucket.count += 1;
    bucket.total += Number(p.amount);
    byCashierMap.set(key, bucket);
  }
  const byCashier = [...byCashierMap.values()].sort((a, b) => b.total - a.total);

  const outstanding = servedOrders.map((o) => {
    const total = orderTotal(o);
    const paid = o.payments.reduce((s, p) => s + Number(p.amount), 0);
    return { id: o.id, orderNumber: o.orderNumber, table: o.table, total, paid, balance: total - paid };
  }).filter((o) => o.balance > 0.01);
  const outstandingBalance = outstanding.reduce((s, o) => s + o.balance, 0);

  const completed = completedOrders.map((o) => ({
    id: o.id,
    orderNumber: o.orderNumber,
    table: o.table,
    total: orderTotal(o),
    paid: o.payments.reduce((s, p) => s + Number(p.amount), 0),
    servedAt: o.servedAt,
    updatedAt: o.updatedAt,
  }));

  res.json({
    range: { from: start.toISOString(), to: end.toISOString() },
    summary: {
      totalRevenue,
      completedOrders: completed.length,
      averageOrderValue: completed.length ? totalRevenue / completed.length : 0,
      outstandingBalance,
      outstandingOrders: outstanding.length,
    },
    byMethod,
    byCashier,
    orders: completed,
    outstanding,
  });
});

type MovementType = (typeof STOCK_MOVEMENT_TYPES)[number];

// Local calendar day the same way dayBounds() reads occurredAt — used to key
// the byDay trend without drifting a movement into the wrong day at UTC
// boundaries.
function localDayKey(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Reconstructs, from the stock ledger alone (so it's correct for any past
 * date range, not just "right now"), opening/closing balances and a
 * movement-type breakdown per product — plus a day-by-day purchases vs.
 * sales(=usage) trend. This is what answers "how much of X did the kitchen
 * get through this week" without a separate live snapshot to keep in sync. */
reportsRouter.get("/inventory", async (req, res, next) => {
  try {
    const query = z.object({
      from: isoDate.optional(),
      to: isoDate.optional(),
      locationId: z.string().trim().optional(),
      productId: z.string().trim().optional(),
    }).safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid filters", details: query.error.flatten() }); return; }
    const tid = tenantId(req);
    const { locationId, productId } = query.data;
    const { start, end } = dayBounds(query.data.from, query.data.to);

    const movements = await prisma.inventoryMovement.findMany({
      where: {
        tenantId: tid,
        occurredAt: { lte: end },
        ...(locationId ? { locationId } : {}),
        ...(productId ? { productId } : {}),
      },
      select: { productId: true, locationId: true, type: true, quantity: true, value: true, occurredAt: true },
      orderBy: { occurredAt: "asc" },
    });

    // Balances here come from summing signed quantity ourselves, in
    // occurredAt order — NOT from the stored balanceAfter snapshots, which
    // are only meaningful in creation order. A backdated entry (a Goods
    // Receipt logged today for last Friday's delivery, say) gets its
    // balanceAfter computed against whatever the balance happened to be at
    // insert time, not its stated date, so it can't be trusted for a
    // historical reconstruction — a running sum over signed quantities is
    // order-independent and always correct.
    const openingBalance = new Map<string, number>();
    const closingBalance = new Map<string, number>();
    type ProductBucket = { qtyByType: Partial<Record<MovementType, number>>; valueByType: Partial<Record<MovementType, number>> };
    const byProductBucket = new Map<string, ProductBucket>();
    const typeTotals: Partial<Record<MovementType, { quantity: number; value: number }>> = {};
    const byDayMap = new Map<string, { purchasesValue: number; salesValue: number; damageValue: number }>();

    for (const m of movements) {
      const key = `${m.productId}::${m.locationId}`;
      const qty = Number(m.quantity);
      const value = m.value != null ? Number(m.value) : 0;
      const inRange = m.occurredAt >= start;

      const running = (closingBalance.get(key) ?? openingBalance.get(key) ?? 0) + qty;
      if (!inRange) {
        openingBalance.set(key, running);
        continue;
      }
      closingBalance.set(key, running);

      const pBucket = byProductBucket.get(m.productId) ?? { qtyByType: {}, valueByType: {} };
      pBucket.qtyByType[m.type] = (pBucket.qtyByType[m.type] ?? 0) + qty;
      pBucket.valueByType[m.type] = (pBucket.valueByType[m.type] ?? 0) + value;
      byProductBucket.set(m.productId, pBucket);

      const t = typeTotals[m.type] ?? { quantity: 0, value: 0 };
      t.quantity += qty;
      t.value += value;
      typeTotals[m.type] = t;

      const dayKey = localDayKey(m.occurredAt);
      const dBucket = byDayMap.get(dayKey) ?? { purchasesValue: 0, salesValue: 0, damageValue: 0 };
      if (m.type === "PURCHASE") dBucket.purchasesValue += value;
      else if (m.type === "SALE") dBucket.salesValue += value;
      else if (m.type === "DAMAGE_LOSS") dBucket.damageValue += value;
      byDayMap.set(dayKey, dBucket);
    }

    // A product carries stock at a location iff it has ever had a movement
    // there — every key seen in either balance map is exactly that set.
    const productIds = new Set<string>();
    const productLocationKeys = new Set([...openingBalance.keys(), ...closingBalance.keys()]);
    for (const key of productLocationKeys) productIds.add(key.split("::")[0]);

    const products = productIds.size
      ? await prisma.product.findMany({
          where: { id: { in: [...productIds] }, tenantId: tid },
          select: { id: true, name: true, unit: true, unitCost: true, reorderLevel: true, category: { select: { name: true } } },
        })
      : [];

    const byProduct = products.map((p) => {
      let opening = 0;
      let closing = 0;
      for (const key of productLocationKeys) {
        if (!key.startsWith(`${p.id}::`)) continue;
        opening += openingBalance.get(key) ?? 0;
        // A key with no in-range movement never entered closingBalance —
        // its balance simply didn't change, so it's still at its opening.
        closing += closingBalance.get(key) ?? openingBalance.get(key) ?? 0;
      }
      const unitCost = p.unitCost != null ? Number(p.unitCost) : 0;
      const bucket = byProductBucket.get(p.id) ?? { qtyByType: {}, valueByType: {} };
      return {
        productId: p.id,
        name: p.name,
        unit: p.unit,
        category: p.category?.name ?? null,
        opening,
        closing,
        closingValue: closing * unitCost,
        purchased: bucket.qtyByType.PURCHASE ?? 0,
        sold: Math.abs(bucket.qtyByType.SALE ?? 0),
        damaged: Math.abs(bucket.qtyByType.DAMAGE_LOSS ?? 0),
        adjusted: bucket.qtyByType.ADJUSTMENT ?? 0,
        reorderLevel: Number(p.reorderLevel),
        low: closing < Number(p.reorderLevel),
      };
    }).sort((a, b) => a.name.localeCompare(b.name));

    const byDay = [...byDayMap.entries()].map(([date, v]) => ({ date, ...v })).sort((a, b) => a.date.localeCompare(b.date));

    const unitCostOf = new Map(products.map((p) => [p.id, p.unitCost != null ? Number(p.unitCost) : 0]));
    const summary = {
      openingValue: byProduct.reduce((s, p) => s + p.opening * (unitCostOf.get(p.productId) ?? 0), 0),
      closingValue: byProduct.reduce((s, p) => s + p.closingValue, 0),
      purchasesValue: typeTotals.PURCHASE?.value ?? 0,
      salesValue: typeTotals.SALE?.value ?? 0,
      damageValue: typeTotals.DAMAGE_LOSS?.value ?? 0,
      lowStockCount: byProduct.filter((p) => p.low).length,
    };

    res.json({
      range: { from: start.toISOString(), to: end.toISOString() },
      summary,
      byProduct,
      byDay,
      lowStock: byProduct.filter((p) => p.low),
    });
  } catch (error) {
    next(error);
  }
});

// ============================================================================
// Sales Report v2 — a full financial report, not just till reconciliation.
// Temporarily a separate path (/sales-v2) alongside the old /sales: the React
// side still reads the old shape, and the two are swapped over together once
// the new page ships, so neither deploy leaves a broken screen live.
// ============================================================================

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

function startOfLocalDay(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0); }
function endOfLocalDay(d: Date) { return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59, 999); }
function addDays(d: Date, n: number) { const r = new Date(d); r.setDate(r.getDate() + n); return r; }
// localDayKey is already defined above, for the Inventory report's byDay trend.

/** day/week(Mon-Sun)/month(calendar)/custom(from-to), all in local time —
 * matches how every other date-ranged report in this file already reads
 * "YYYY-MM-DD" as local midnight, not UTC. */
function resolveSalesRange(period: "day" | "week" | "month" | "custom", dateStr: string | undefined, fromStr: string | undefined, toStr: string | undefined) {
  const anchor = dateStr ? new Date(`${dateStr}T00:00:00.000`) : new Date();
  if (period === "custom") {
    const start = startOfLocalDay(new Date(`${fromStr}T00:00:00.000`));
    const end = endOfLocalDay(new Date(`${toStr ?? fromStr}T00:00:00.000`));
    return { start, end };
  }
  if (period === "week") {
    const diffToMonday = (anchor.getDay() + 6) % 7; // Sun=0..Sat=6 -> days back to Monday
    const monday = addDays(anchor, -diffToMonday);
    return { start: startOfLocalDay(monday), end: endOfLocalDay(addDays(monday, 6)) };
  }
  if (period === "month") {
    const first = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
    const last = new Date(anchor.getFullYear(), anchor.getMonth() + 1, 0);
    return { start: startOfLocalDay(first), end: endOfLocalDay(last) };
  }
  return { start: startOfLocalDay(anchor), end: endOfLocalDay(anchor) };
}

type Moneyish = Prisma.Decimal | number | null;

/** Cost of one sold line (quantity already applied), checked in priority
 * order: a direct retail-product sale, then a variant's own bar/stock link,
 * then the menu item's recipe, then the menu item's own direct product link.
 * Null means "can't be costed" (a Service line, or a MenuItem with none of
 * the above) — never silently treated as zero, so it can be surfaced as a
 * caveat instead of quietly inflating Net Revenue. */
type CostableItem = {
  quantity: number;
  product: { unitCost: Moneyish } | null;
  variant: { stockQtyPerUnit: Moneyish; stockProduct: { unitCost: Moneyish } | null } | null;
  service: { id: string } | null;
  menuItem: {
    stockQtyPerUnit: Moneyish;
    product: { unitCost: Moneyish } | null;
    recipe: { ingredients: { quantity: Moneyish; product: { unitCost: Moneyish } }[] } | null;
  } | null;
};

function resolveItemCost(item: CostableItem): number | null {
  if (item.product) return item.product.unitCost != null ? Number(item.product.unitCost) * item.quantity : null;
  if (item.variant?.stockProduct) {
    const perUnit = Number(item.variant.stockQtyPerUnit ?? 1);
    return item.variant.stockProduct.unitCost != null ? Number(item.variant.stockProduct.unitCost) * perUnit * item.quantity : null;
  }
  if (item.menuItem?.recipe?.ingredients.length) {
    if (item.menuItem.recipe.ingredients.some((ing) => ing.product.unitCost == null)) return null;
    const perUnit = item.menuItem.recipe.ingredients.reduce((s, ing) => s + Number(ing.quantity) * Number(ing.product.unitCost), 0);
    return perUnit * item.quantity;
  }
  if (item.menuItem?.product) {
    const perUnit = Number(item.menuItem.stockQtyPerUnit ?? 1);
    return item.menuItem.product.unitCost != null ? Number(item.menuItem.product.unitCost) * perUnit * item.quantity : null;
  }
  if (item.service) return 0;
  return null;
}

const salesQuerySchema = z.object({
  period: z.enum(["day", "week", "month", "custom"]).default("day"),
  date: isoDate.optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  locationId: z.string().trim().optional(),
}).refine((v) => v.period !== "custom" || !!v.from, { message: "A custom range needs a from date", path: ["from"] });

const orderItemInclude = {
  addons: { select: { quantity: true, unitPrice: true } },
  product: { select: { id: true, name: true, unit: true, unitCost: true } },
  service: { select: { id: true, name: true } },
  variant: { select: { id: true, name: true, stockQtyPerUnit: true, stockProduct: { select: { unitCost: true } } } },
  menuItem: {
    select: {
      id: true,
      name: true,
      stockQtyPerUnit: true,
      product: { select: { unitCost: true } },
      recipe: { select: { ingredients: { select: { quantity: true, product: { select: { unitCost: true } } } } } },
    },
  },
} as const;

reportsRouter.get("/sales-v2", async (req, res, next) => {
  try {
    const query = salesQuerySchema.safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid report filters", details: query.error.flatten() }); return; }
    const { period, date, from, to, locationId } = query.data;
    const tid = tenantId(req);
    const { start, end } = resolveSalesRange(period, date, from, to);
    const trendStart = startOfLocalDay(addDays(end, -5));
    const trendEnd = endOfLocalDay(addDays(end, 5));

    const [
      tax, completedOrders, cancelledOrders, transactionsIn, trendTransactions,
      appointmentsPaid, membershipPayments, expenses, goodsReceiptItems,
      cancelledPurchases, supplierPayments, debtorCustomers, openFolios,
      creditorSuppliers, employeesForBranch,
    ] = await Promise.all([
      taxSettingsFor(tid),
      prisma.posOrder.findMany({
        where: { tenantId: tid, status: "COMPLETED", updatedAt: { gte: start, lte: end }, ...(locationId ? { locationId } : {}) },
        include: { items: { include: orderItemInclude }, location: { select: { id: true, name: true } } },
      }),
      prisma.posOrder.findMany({
        where: { tenantId: tid, status: "CANCELLED", updatedAt: { gte: start, lte: end }, ...(locationId ? { locationId } : {}) },
        include: { items: { include: { addons: { select: { quantity: true, unitPrice: true } } } } },
      }),
      prisma.transaction.findMany({
        where: { tenantId: tid, direction: "IN", status: "COMPLETE", createdAt: { gte: start, lte: end }, ...(locationId ? { locationId } : {}) },
        include: { paymentMethod: { select: { id: true, name: true } } },
      }),
      prisma.transaction.findMany({
        where: { tenantId: tid, direction: "IN", status: "COMPLETE", createdAt: { gte: trendStart, lte: trendEnd }, ...(locationId ? { locationId } : {}) },
        select: { amount: true, createdAt: true },
      }),
      locationId ? Promise.resolve([]) : prisma.appointment.findMany({ where: { tenantId: tid, paymentStatus: "PAID", updatedAt: { gte: start, lte: end } }, select: { amount: true } }),
      locationId ? Promise.resolve([]) : prisma.membershipPayment.findMany({ where: { tenantId: tid, status: "PAID", createdAt: { gte: start, lte: end } }, select: { amount: true } }),
      prisma.expense.findMany({ where: { tenantId: tid, status: "ACTIVE", expenseDate: { gte: start, lte: end }, ...(locationId ? { locationId } : {}) }, include: { category: { select: { name: true } } } }),
      prisma.goodsReceiptItem.findMany({
        where: { goodsReceipt: { tenantId: tid, receivedAt: { gte: start, lte: end }, ...(locationId ? { locationId } : {}) } },
        select: { quantity: true, unitCost: true, goodsReceipt: { select: { purchase: { select: { supplierId: true, supplier: { select: { name: true } } } } } } },
      }),
      prisma.purchase.findMany({ where: { tenantId: tid, status: "CANCELLED", updatedAt: { gte: start, lte: end } }, select: { id: true, total: true } }),
      prisma.supplierPayment.findMany({ where: { tenantId: tid, paidAt: { gte: start, lte: end } }, select: { amount: true } }),
      prisma.customer.findMany({ where: { tenantId: tid, balance: { gt: 0 } }, select: { id: true, firstName: true, lastName: true, balance: true }, orderBy: { balance: "desc" } }),
      prisma.folio.findMany({
        where: { tenantId: tid, status: "OPEN" },
        select: { folioNo: true, lineItems: { select: { amount: true, quantity: true } }, payments: { select: { amount: true } }, reservation: { select: { reservationNo: true, customer: { select: { firstName: true, lastName: true } } } } },
      }),
      prisma.supplier.findMany({ where: { tenantId: tid, balance: { gt: 0 } }, select: { id: true, name: true, balance: true }, orderBy: { balance: "desc" } }),
      prisma.employee.findMany({ where: { tenantId: tid }, select: { id: true, firstName: true, lastName: true, defaultLocation: { select: { name: true } } } }),
    ]);

    // ---- Total Revenue: cash actually received (Transaction ledger is the
    // single source of truth here — it already avoids double-counting a
    // room-billed POS sale at both ring-up and checkout). Appointments and
    // memberships aren't tenant-location-tagged yet, so they're folded in
    // only for the all-locations view. ----
    const posSalesCash = round2(transactionsIn.filter((t) => t.source === "POS_SALE").reduce((s, t) => s + Number(t.amount), 0));
    const folioDepositsCash = round2(transactionsIn.filter((t) => t.source === "FOLIO_DEPOSIT").reduce((s, t) => s + Number(t.amount), 0));
    const folioSettlementsCash = round2(transactionsIn.filter((t) => t.source === "FOLIO_SETTLEMENT").reduce((s, t) => s + Number(t.amount), 0));
    const serviceCenterCash = round2(appointmentsPaid.reduce((s, a) => s + Number(a.amount), 0) + membershipPayments.reduce((s, m) => s + Number(m.amount), 0));
    const totalRevenue = round2(posSalesCash + folioDepositsCash + folioSettlementsCash + serviceCenterCash);

    // ---- Completed orders: the sales-volume + Net Revenue/Profit basis.
    // Deliberately NOT the same base as Total Revenue above — a sale settled
    // on credit is "sold" (counts here) before it's "paid" (counts there).
    // Each figure is labeled for exactly what it is; see the Reports.tsx
    // "how we calculate this" panel. ----
    let completedSalesValue = 0;
    let cogsTotal = 0;
    let unresolvedCostLines = 0;
    let itemsSold = 0;
    let taxCollected = 0;
    let discountsGiven = 0;
    let menuOrdersCompleted = 0;
    const taxBuckets = new Map<string, { key: string; label: string; treatment: string; rate: number; mode: string; net: number; tax: number; gross: number }>();
    const topItemsMap = new Map<string, { name: string; qty: number; revenue: number }>();
    const byLocationMap = new Map<string, { name: string; count: number; revenue: number; cogs: number }>();

    for (const order of completedOrders) {
      const fin = computeOrderFinancials(order, tax);
      completedSalesValue += fin.total;
      taxCollected += fin.taxAmount;
      discountsGiven += Number(order.discount);
      if (order.channel === "FOOD") menuOrdersCompleted += 1;

      for (const line of fin.taxLines) {
        const bucket = taxBuckets.get(line.key) ?? { ...line, net: 0, tax: 0, gross: 0 };
        bucket.net += line.net; bucket.tax += line.tax; bucket.gross += line.gross;
        taxBuckets.set(line.key, bucket);
      }

      let orderCogs = 0;
      for (const item of order.items) {
        itemsSold += item.quantity;
        const cost = resolveItemCost(item);
        if (cost == null) unresolvedCostLines += 1; else orderCogs += cost;
        const key = item.menuItem?.id ?? item.product?.id ?? item.service?.id ?? "unknown";
        const name = item.menuItem?.name ?? item.product?.name ?? item.service?.name ?? "Unknown";
        const bucket = topItemsMap.get(key) ?? { name, qty: 0, revenue: 0 };
        bucket.qty += item.quantity;
        bucket.revenue += Number(item.unitPrice) * item.quantity;
        topItemsMap.set(key, bucket);
      }
      cogsTotal += orderCogs;

      const locKey = order.locationId ?? "unassigned";
      const locBucket = byLocationMap.get(locKey) ?? { name: order.location?.name ?? "Unassigned", count: 0, revenue: 0, cogs: 0 };
      locBucket.count += 1;
      locBucket.revenue += fin.total;
      locBucket.cogs += orderCogs;
      byLocationMap.set(locKey, locBucket);
    }
    completedSalesValue = round2(completedSalesValue);
    cogsTotal = round2(cogsTotal);
    taxCollected = round2(taxCollected);
    discountsGiven = round2(discountsGiven);

    const topItems = [...topItemsMap.values()].sort((a, b) => b.revenue - a.revenue).slice(0, 10).map((i) => ({ ...i, revenue: round2(i.revenue) }));
    const taxBreakdown = [...taxBuckets.values()].map((b) => ({ ...b, net: round2(b.net), tax: round2(b.tax), gross: round2(b.gross) })).sort((a, b) => b.gross - a.gross);

    // ---- Expenses ----
    const totalExpenses = round2(expenses.reduce((s, e) => s + Number(e.amount), 0));
    const expensesByCategoryMap = new Map<string, { name: string; count: number; total: number }>();
    const expensesByLocationMap = new Map<string, number>();
    for (const e of expenses) {
      const catBucket = expensesByCategoryMap.get(e.categoryId) ?? { name: e.category.name, count: 0, total: 0 };
      catBucket.count += 1; catBucket.total += Number(e.amount);
      expensesByCategoryMap.set(e.categoryId, catBucket);
      const locKey = e.locationId ?? "unassigned";
      expensesByLocationMap.set(locKey, (expensesByLocationMap.get(locKey) ?? 0) + Number(e.amount));
    }
    const expensesByCategory = [...expensesByCategoryMap.values()].map((b) => ({ ...b, total: round2(b.total) })).sort((a, b) => b.total - a.total);

    // ---- Purchases ----
    const purchasesBySupplierMap = new Map<string, { name: string; count: number; total: number }>();
    for (const gri of goodsReceiptItems) {
      const supplierId = gri.goodsReceipt.purchase.supplierId;
      const bucket = purchasesBySupplierMap.get(supplierId) ?? { name: gri.goodsReceipt.purchase.supplier.name, count: 0, total: 0 };
      bucket.count += 1;
      bucket.total += Number(gri.quantity) * Number(gri.unitCost);
      purchasesBySupplierMap.set(supplierId, bucket);
    }
    const purchasesBySupplier = [...purchasesBySupplierMap.values()].map((b) => ({ ...b, total: round2(b.total) })).sort((a, b) => b.total - a.total);
    const cancelledPurchasesSummary = { count: cancelledPurchases.length, value: round2(cancelledPurchases.reduce((s, p) => s + Number(p.total), 0)) };
    const capitalInvested = round2(supplierPayments.reduce((s, p) => s + Number(p.amount), 0));

    // ---- Net Revenue / Net Profit ----
    const netRevenue = round2(completedSalesValue - cogsTotal);
    const netProfit = round2(netRevenue - totalExpenses);

    // ---- Cards ----
    const transactionsCount = completedOrders.length;
    const averageSale = transactionsCount ? round2(completedSalesValue / transactionsCount) : 0;

    // ---- Sales by location (net profit + % needs that location's own
    // expenses, not the tenant-wide total) ----
    const salesByLocation = [...byLocationMap.entries()].map(([locId, b]) => {
      const locExpenses = round2(expensesByLocationMap.get(locId) ?? 0);
      const netProfitHere = round2(b.revenue - b.cogs - locExpenses);
      return {
        locationId: locId === "unassigned" ? null : locId,
        name: b.name,
        transactions: b.count,
        revenue: round2(b.revenue),
        avgSale: b.count ? round2(b.revenue / b.count) : 0,
        percentOfTotal: completedSalesValue ? round2((b.revenue / completedSalesValue) * 100) : 0,
        expenses: locExpenses,
        netProfit: netProfitHere,
        profitPercent: b.revenue ? round2((netProfitHere / b.revenue) * 100) : 0,
      };
    }).sort((a, b) => b.revenue - a.revenue);

    // ---- Sales by payment method / by employee (cash-basis, from the
    // Transaction ledger — same set that built Total Revenue above, minus
    // service-center bookings which have no method/employee here) ----
    const transactionsInTotal = round2(transactionsIn.reduce((s, t) => s + Number(t.amount), 0));
    const byMethodMap = new Map<string, { name: string; count: number; total: number }>();
    for (const t of transactionsIn) {
      const key = t.paymentMethodId ?? "unknown";
      const bucket = byMethodMap.get(key) ?? { name: t.paymentMethod?.name ?? "Unknown", count: 0, total: 0 };
      bucket.count += 1; bucket.total += Number(t.amount);
      byMethodMap.set(key, bucket);
    }
    const byPaymentMethod = [...byMethodMap.values()]
      .map((b) => ({ ...b, total: round2(b.total), percentOfTotal: transactionsInTotal ? round2((b.total / transactionsInTotal) * 100) : 0 }))
      .sort((a, b) => b.total - a.total);

    const employeeName = new Map(employeesForBranch.map((e) => [e.id, `${e.firstName} ${e.lastName}`.trim()]));
    const employeeBranch = new Map(employeesForBranch.map((e) => [e.id, e.defaultLocation?.name ?? "—"]));
    const byEmployeeMap = new Map<string, { name: string; branch: string; count: number; total: number }>();
    for (const t of transactionsIn) {
      const key = t.employeeId ?? "unattributed";
      const bucket = byEmployeeMap.get(key) ?? {
        name: t.employeeId ? employeeName.get(t.employeeId) ?? "Unknown" : "Unattributed",
        branch: t.employeeId ? employeeBranch.get(t.employeeId) ?? "—" : "—",
        count: 0, total: 0,
      };
      bucket.count += 1; bucket.total += Number(t.amount);
      byEmployeeMap.set(key, bucket);
    }
    const byEmployee = [...byEmployeeMap.values()]
      .map((b) => ({ ...b, total: round2(b.total), percentOfTotal: transactionsInTotal ? round2((b.total / transactionsInTotal) * 100) : 0 }))
      .sort((a, b) => b.total - a.total);

    // ---- Voided sales / (unsupported) returns ----
    const voided = { count: cancelledOrders.length, value: round2(cancelledOrders.reduce((s, o) => s + computeOrderFinancials(o, tax).total, 0)) };
    const returns = { supported: false, count: 0, value: 0, note: "Partial refunds aren't tracked yet — only whole-order voids are." };

    // ---- Revenue trend: 11 days centered on the range's end date ----
    const trendMap = new Map<string, number>();
    for (let d = trendStart; d <= trendEnd; d = addDays(d, 1)) trendMap.set(localDayKey(d), 0);
    for (const t of trendTransactions) trendMap.set(localDayKey(t.createdAt), (trendMap.get(localDayKey(t.createdAt)) ?? 0) + Number(t.amount));
    const trend = [...trendMap.entries()].map(([trendDate, value]) => ({ date: trendDate, revenue: round2(value) }));

    // ---- Debtors: a live snapshot, not scoped to the selected period —
    // Customer.balance (credit sales) and open Folios (unsettled room bills)
    // are two separate, non-overlapping mechanisms. ----
    const customerDebtTotal = round2(debtorCustomers.reduce((s, c) => s + Number(c.balance), 0));
    const folioBalances = openFolios
      .map((f) => {
        const charges = f.lineItems.reduce((s, li) => s + Number(li.amount) * li.quantity, 0);
        const paid = f.payments.reduce((s, p) => s + Number(p.amount), 0);
        return {
          folioNo: f.folioNo,
          reservationNo: f.reservation.reservationNo,
          guestName: `${f.reservation.customer.firstName} ${f.reservation.customer.lastName ?? ""}`.trim(),
          balance: round2(charges - paid),
        };
      })
      .filter((f) => f.balance > 0.01)
      .sort((a, b) => b.balance - a.balance);
    const folioDebtTotal = round2(folioBalances.reduce((s, f) => s + f.balance, 0));
    const debtors = {
      total: round2(customerDebtTotal + folioDebtTotal),
      customers: { total: customerDebtTotal, top: debtorCustomers.slice(0, 15).map((c) => ({ id: c.id, name: `${c.firstName} ${c.lastName ?? ""}`.trim(), balance: round2(Number(c.balance)) })) },
      unsettledFolios: { total: folioDebtTotal, top: folioBalances.slice(0, 15) },
    };

    // ---- Creditors: also a live snapshot ----
    const creditorTotal = round2(creditorSuppliers.reduce((s, sup) => s + Number(sup.balance), 0));
    const creditors = {
      total: creditorTotal,
      top: creditorSuppliers.slice(0, 15).map((s) => ({ id: s.id, name: s.name, balance: round2(Number(s.balance)) })),
    };

    const expectedProfit = round2(netProfit + debtors.total - creditors.total);

    res.json({
      range: { period, start: start.toISOString(), end: end.toISOString() },
      cards: { totalRevenue, netRevenue, totalExpenses, netProfit, capitalInvested, transactions: transactionsCount, averageSale, itemsSold, menuOrdersCompleted },
      revenueBreakdown: {
        posSalesCash, folioDepositsCash, folioSettlementsCash, serviceCenterCash, totalRevenue,
        taxCollected, discountsGiven,
        completedSalesValue, cogs: cogsTotal, unresolvedCostLines, netRevenue,
        serviceCenterExcludedByLocationFilter: !!locationId,
      },
      topItems,
      expensesByCategory,
      purchasesBySupplier,
      trend,
      salesByLocation,
      byPaymentMethod,
      byEmployee,
      voided,
      returns,
      cancelledPurchases: cancelledPurchasesSummary,
      debtors,
      creditors,
      expectedProfit,
      taxBreakdown,
    });
  } catch (error) {
    next(error);
  }
});
