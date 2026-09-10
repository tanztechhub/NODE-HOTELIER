import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";
import { partialNoDefaults } from "../../lib/zod.js";

// Menu ▸ Add-on Groups (Phase 4). Reusable selection rule-sets. Holds no
// add-ons itself — those attach in Phase 6.
export const addonGroupsRouter = Router();
addonGroupsRouter.use(requireModule("POS"));

const SELECTION_TYPES = ["SINGLE", "MULTIPLE"] as const;

const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());

const baseShape = {
  name: z.string().trim().min(1).max(80),
  description: optionalText(280),
  selectionType: z.enum(SELECTION_TYPES).default("SINGLE"),
  minSelections: z.coerce.number().int().min(0).max(50).default(0),
  maxSelections: z.coerce.number().int().min(1).max(50).default(1),
  required: z.boolean().default(false),
  isActive: z.boolean().default(true),
  sortOrder: z.coerce.number().int().min(0).max(99999).optional(),
};

// Cross-field rules from the spec. Applied to whichever fields the caller
// actually sent, filled from the current row on update.
function checkRules(g: { selectionType: string; minSelections: number; maxSelections: number; required: boolean }): string | null {
  if (g.maxSelections < g.minSelections) return "Max selections can't be less than min";
  if (g.selectionType === "SINGLE" && g.maxSelections !== 1) return "A single-choice group must allow exactly 1 selection";
  if (g.required && g.minSelections < 1) return "A required group must allow at least 1 selection";
  return null;
}

const createSchema = z.object(baseShape).superRefine((val, ctx) => {
  const msg = checkRules(val);
  if (msg) ctx.addIssue({ code: "custom", message: msg, path: ["maxSelections"] });
});
const updateSchema = partialNoDefaults(z.object(baseShape));
const reorderSchema = z.object({ orderedIds: z.array(z.string().trim().min(1)).min(1) });

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const groupFields = {
  id: true,
  name: true,
  description: true,
  selectionType: true,
  minSelections: true,
  maxSelections: true,
  required: true,
  isActive: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { items: true, menuItemLinks: true } },
} as const;
const orderBy: Prisma.AddonGroupOrderByWithRelationInput[] = [{ sortOrder: "asc" }, { name: "asc" }];

// AddonGroupItem — the add-ons in a group (Phase 6).
const groupItemFields = {
  id: true,
  addonGroupId: true,
  addonId: true,
  sortOrder: true,
  isActive: true,
  addon: { select: { id: true, name: true, price: true, sku: true, imageUrl: true, isActive: true } },
} as const;
const groupItemOrderBy: Prisma.AddonGroupItemOrderByWithRelationInput[] = [{ sortOrder: "asc" }, { addon: { name: "asc" } }];

async function assertGroup(tid: string, addonGroupId: string) {
  const g = await prisma.addonGroup.findFirst({ where: { id: addonGroupId, tenantId: tid }, select: { id: true } });
  if (!g) throw Object.assign(new Error("Add-on group not found"), { status: 404 });
}

const addItemSchema = z.object({ addonId: z.string().trim().min(1), sortOrder: z.coerce.number().int().min(0).max(99999).optional() });
const patchItemSchema = z.object({ isActive: z.boolean() });
const itemReorderSchema = z.object({ orderedIds: z.array(z.string().trim().min(1)).min(1) });

addonGroupsRouter.get("/", async (req, res, next) => {
  try {
    const query = z.object({ search: optionalText(80), active: z.enum(["true", "false"]).optional() }).safeParse(req.query);
    if (!query.success) { res.status(400).json({ error: "Invalid filters", details: query.error.flatten() }); return; }
    const { search, active } = query.data;
    const groups = await prisma.addonGroup.findMany({
      where: {
        tenantId: tenantId(req),
        ...(active ? { isActive: active === "true" } : {}),
        ...(search ? { name: { contains: search, mode: "insensitive" } } : {}),
      },
      select: groupFields,
      orderBy,
    });
    res.json({ groups });
  } catch (error) {
    next(error);
  }
});

addonGroupsRouter.get("/:id", async (req, res, next) => {
  try {
    const group = await prisma.addonGroup.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: groupFields });
    if (!group) { res.status(404).json({ error: "Add-on group not found" }); return; }
    res.json({ group });
  } catch (error) {
    next(error);
  }
});

addonGroupsRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid add-on group", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    let { sortOrder } = data.data;
    if (sortOrder === undefined) {
      const last = await prisma.addonGroup.findFirst({ where: { tenantId: tid }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
      sortOrder = (last?.sortOrder ?? -1) + 1;
    }
    const group = await prisma.addonGroup.create({ data: { tenantId: tid, ...data.data, sortOrder }, select: groupFields });
    res.status(201).json({ group });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "An add-on group with this name already exists" }); return; }
    next(error);
  }
});

addonGroupsRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid add-on group", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const existing = await prisma.addonGroup.findFirst({ where: { id: req.params.id, tenantId: tid }, select: groupFields });
    if (!existing) { res.status(404).json({ error: "Add-on group not found" }); return; }
    const merged = {
      selectionType: data.data.selectionType ?? existing.selectionType,
      minSelections: data.data.minSelections ?? existing.minSelections,
      maxSelections: data.data.maxSelections ?? existing.maxSelections,
      required: data.data.required ?? existing.required,
    };
    const msg = checkRules(merged);
    if (msg) { res.status(400).json({ error: msg }); return; }
    const group = await prisma.addonGroup.update({ where: { id: existing.id }, data: data.data, select: groupFields });
    res.json({ group });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "An add-on group with this name already exists" }); return; }
    next(error);
  }
});

addonGroupsRouter.post("/reorder", async (req, res, next) => {
  const data = reorderSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid order", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const owned = await prisma.addonGroup.count({ where: { id: { in: data.data.orderedIds }, tenantId: tid } });
    if (owned !== new Set(data.data.orderedIds).size) { res.status(400).json({ error: "Every group must belong to this property" }); return; }
    await prisma.$transaction(data.data.orderedIds.map((id, index) => prisma.addonGroup.update({ where: { id }, data: { sortOrder: index } })));
    const groups = await prisma.addonGroup.findMany({ where: { tenantId: tid }, select: groupFields, orderBy });
    res.json({ groups });
  } catch (error) {
    next(error);
  }
});

addonGroupsRouter.delete("/:id", async (req, res, next) => {
  try {
    const existing = await prisma.addonGroup.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: { id: true } });
    if (!existing) { res.status(404).json({ error: "Add-on group not found" }); return; }
    const links = await prisma.menuItemAddonGroup.count({ where: { addonGroupId: existing.id } });
    if (links > 0) { res.status(409).json({ error: `This group is on ${links} menu item${links === 1 ? "" : "s"} — remove it from those first` }); return; }
    // Its add-on links (AddonGroupItem) cascade away; the add-ons survive.
    await prisma.addonGroup.delete({ where: { id: existing.id } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});

// ── Group ▸ Add-ons (Phase 6) ───────────────────────────────────────────

addonGroupsRouter.get("/:groupId/items", async (req, res, next) => {
  try {
    const tid = tenantId(req);
    await assertGroup(tid, req.params.groupId);
    const items = await prisma.addonGroupItem.findMany({ where: { tenantId: tid, addonGroupId: req.params.groupId }, select: groupItemFields, orderBy: groupItemOrderBy });
    res.json({ items });
  } catch (error) {
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

// Attach an EXISTING add-on to the group. Never creates an add-on.
addonGroupsRouter.post("/:groupId/items", async (req, res, next) => {
  const data = addItemSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid request", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    await assertGroup(tid, req.params.groupId);
    const addon = await prisma.addon.findFirst({ where: { id: data.data.addonId, tenantId: tid }, select: { id: true } });
    if (!addon) { res.status(400).json({ error: "Choose an add-on from this property" }); return; }
    let { sortOrder } = data.data;
    if (sortOrder === undefined) {
      const last = await prisma.addonGroupItem.findFirst({ where: { tenantId: tid, addonGroupId: req.params.groupId }, orderBy: { sortOrder: "desc" }, select: { sortOrder: true } });
      sortOrder = (last?.sortOrder ?? -1) + 1;
    }
    const item = await prisma.addonGroupItem.create({ data: { tenantId: tid, addonGroupId: req.params.groupId, addonId: data.data.addonId, sortOrder }, select: groupItemFields });
    res.status(201).json({ item });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "That add-on is already in this group" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

addonGroupsRouter.patch("/:groupId/items/:id", async (req, res, next) => {
  const data = patchItemSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid request", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const updated = await prisma.addonGroupItem.updateMany({ where: { id: req.params.id, tenantId: tid, addonGroupId: req.params.groupId }, data: data.data });
    if (!updated.count) { res.status(404).json({ error: "Not in this group" }); return; }
    const item = await prisma.addonGroupItem.findUniqueOrThrow({ where: { id: req.params.id }, select: groupItemFields });
    res.json({ item });
  } catch (error) {
    next(error);
  }
});

addonGroupsRouter.post("/:groupId/items/reorder", async (req, res, next) => {
  const data = itemReorderSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid order", details: data.error.flatten() }); return; }
  const tid = tenantId(req);
  try {
    const owned = await prisma.addonGroupItem.count({ where: { id: { in: data.data.orderedIds }, tenantId: tid, addonGroupId: req.params.groupId } });
    if (owned !== new Set(data.data.orderedIds).size) { res.status(400).json({ error: "Every entry must belong to this group" }); return; }
    await prisma.$transaction(data.data.orderedIds.map((id, index) => prisma.addonGroupItem.update({ where: { id }, data: { sortOrder: index } })));
    const items = await prisma.addonGroupItem.findMany({ where: { tenantId: tid, addonGroupId: req.params.groupId }, select: groupItemFields, orderBy: groupItemOrderBy });
    res.json({ items });
  } catch (error) {
    next(error);
  }
});

// Remove an add-on from the group (the add-on itself is untouched).
addonGroupsRouter.delete("/:groupId/items/:id", async (req, res, next) => {
  try {
    const deleted = await prisma.addonGroupItem.deleteMany({ where: { id: req.params.id, tenantId: tenantId(req), addonGroupId: req.params.groupId } });
    if (!deleted.count) { res.status(404).json({ error: "Not in this group" }); return; }
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
