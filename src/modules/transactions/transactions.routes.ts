import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";

// A unified, read-only ledger of every payment actually made across the
// business. Rows are only ever created as a side effect of a real payment
// elsewhere (reception folio, POS bill settlement) — there is no direct
// write endpoint here.
export const transactionsRouter = Router();

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const listSchema = z.object({
  direction: z.enum(["IN", "OUT"]).optional(),
  source: z.enum(["FOLIO_DEPOSIT", "FOLIO_SETTLEMENT", "POS_SALE", "EXPENSE", "ASSET_PURCHASE", "SUPPLIER_PAYMENT"]).optional(),
  paymentMethodId: z.string().trim().min(1).optional(),
  search: optionalText(120),
  from: z.preprocess(blankToUndefined, z.coerce.date().optional()),
  to: z.preprocess(blankToUndefined, z.coerce.date().optional()),
});

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const transactionInclude = {
  paymentMethod: { select: { id: true, name: true } },
  customer: { select: { id: true, firstName: true, lastName: true } },
  supplier: { select: { id: true, name: true } },
  location: { select: { id: true, name: true } },
  employee: { select: { id: true, firstName: true, lastName: true } },
} as const;

transactionsRouter.get("/", async (req, res) => {
  const query = listSchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid transaction filters", details: query.error.flatten() }); return; }
  const { direction, source, paymentMethodId, search, from, to } = query.data;
  const tid = tenantId(req);

  const transactions = await prisma.transaction.findMany({
    where: {
      tenantId: tid,
      ...(direction ? { direction } : {}),
      ...(source ? { source } : {}),
      ...(paymentMethodId ? { paymentMethodId } : {}),
      ...(from || to ? { createdAt: { ...(from ? { gte: from } : {}), ...(to ? { lte: to } : {}) } } : {}),
      ...(search
        ? {
            OR: [
              { transactionNo: { contains: search, mode: "insensitive" } },
              { reference: { contains: search, mode: "insensitive" } },
              { description: { contains: search, mode: "insensitive" } },
              { customer: { firstName: { contains: search, mode: "insensitive" } } },
              { customer: { lastName: { contains: search, mode: "insensitive" } } },
              { supplier: { name: { contains: search, mode: "insensitive" } } },
            ],
          }
        : {}),
    },
    include: transactionInclude,
    orderBy: { createdAt: "desc" },
  });

  const totalIn = transactions.filter((t) => t.direction === "IN").reduce((s, t) => s + Number(t.amount), 0);
  const totalOut = transactions.filter((t) => t.direction === "OUT").reduce((s, t) => s + Number(t.amount), 0);
  res.json({ transactions, summary: { totalIn, totalOut, count: transactions.length } });
});
