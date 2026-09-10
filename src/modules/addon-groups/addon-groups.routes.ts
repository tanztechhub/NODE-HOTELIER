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
} as const;
const orderBy: Prisma.AddonGroupOrderByWithRelationInput[] = [{ sortOrder: "asc" }, { name: "asc" }];

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
    // No references possible yet — links to add-ons (Phase 6) and menu items
    // (Phase 7) will add safety checks here.
    await prisma.addonGroup.delete({ where: { id: existing.id } });
    res.status(204).send();
  } catch (error) {
    next(error);
  }
});
