import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireAdmin, requireModule } from "../../middleware/tenantContext.js";

export const storeRouter = Router();
storeRouter.use(requireModule("STORE"));
const schema = z.object({ name: z.string().trim().min(2).max(80), code: z.string().trim().min(2).max(20).transform((v) => v.toUpperCase()), isActive: z.boolean().default(true) });
const tenantId = (req: { tenantId?: string }) => { if (!req.tenantId) throw new Error("Tenant context is required"); return req.tenantId; };

storeRouter.get("/", async (req, res) => res.json({ stores: await prisma.store.findMany({ where: { tenantId: tenantId(req) }, include: { _count: { select: { products: true } } }, orderBy: { name: "asc" } }) }));
storeRouter.post("/", async (req, res) => { const data = schema.safeParse(req.body); if (!data.success) { res.status(400).json({ error: "Invalid store", details: data.error.flatten() }); return; } res.status(201).json({ store: await prisma.store.create({ data: { tenantId: tenantId(req), ...data.data } }) }); });
storeRouter.patch("/:id", async (req, res) => { const data = schema.partial().safeParse(req.body); if (!data.success) { res.status(400).json({ error: "Invalid store", details: data.error.flatten() }); return; } const updated = await prisma.store.updateMany({ where: { id: req.params.id, tenantId: tenantId(req) }, data: data.data }); if (!updated.count) { res.status(404).json({ error: "Store not found" }); return; } res.json({ store: await prisma.store.findUniqueOrThrow({ where: { id: req.params.id } }) }); });
storeRouter.get("/:id/movements", async (req, res) => { const store = await prisma.store.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) } }); if (!store) { res.status(404).json({ error: "Store not found" }); return; } const movements = await prisma.inventoryMovement.findMany({ where: { storeId: store.id, tenantId: store.tenantId }, include: { product: { select: { id: true, name: true, sku: true, unit: true } } }, orderBy: { occurredAt: "desc" } }); res.json({ store, movements }); });
storeRouter.delete("/:id", requireAdmin, async (req, res) => { const deleted = await prisma.store.deleteMany({ where: { id: String(req.params.id), tenantId: tenantId(req) } }); if (!deleted.count) { res.status(404).json({ error: "Store not found" }); return; } res.status(204).send(); });
