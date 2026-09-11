import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { computeOrderFinancials } from "../../lib/orderTotals.js";
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
