import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { computeOrderFinancials } from "../../lib/orderTotals.js";

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
