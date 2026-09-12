import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { requireModule, requirePermission } from "../../middleware/tenantContext.js";
import { partialNoDefaults } from "../../lib/zod.js";
import { resolveShiftFor, isWithinShift } from "../../lib/shifts.js";

export const shiftsRouter = Router();
shiftsRouter.use(requireModule("HR"));

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use 24-hour HH:mm, e.g. 06:00");

const templateSchema = z.object({
  name: z.string().trim().min(1).max(60),
  startTime: hhmm,
  endTime: hhmm,
  graceMinutesBefore: z.coerce.number().int().min(0).max(180).default(15),
  graceMinutesAfter: z.coerce.number().int().min(0).max(180).default(15),
  isActive: z.boolean().default(true),
});
const updateTemplateSchema = partialNoDefaults(templateSchema);

shiftsRouter.get("/templates", async (req, res) => {
  const templates = await prisma.shiftTemplate.findMany({ where: { tenantId: tenantId(req) }, orderBy: { name: "asc" } });
  res.json({ templates });
});

/** Every employee's configured rotation, for the management list — an
 * employee with none simply doesn't appear here (unrestricted). */
shiftsRouter.get("/rotations", async (req, res) => {
  const rotations = await prisma.employeeShiftRotation.findMany({
    where: { tenantId: tenantId(req) },
    include: {
      employee: { select: { id: true, firstName: true, lastName: true, jobTitle: true } },
      slots: { include: { shiftTemplate: true }, orderBy: { position: "asc" } },
    },
  });
  res.json({ rotations });
});

shiftsRouter.post("/templates", requirePermission("SHIFT_MANAGE"), async (req, res, next) => {
  const data = templateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid shift", details: data.error.flatten() }); return; }
  try {
    const template = await prisma.shiftTemplate.create({ data: { tenantId: tenantId(req), ...data.data } });
    res.status(201).json({ template });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A shift with this name already exists" }); return; }
    next(error);
  }
});

shiftsRouter.patch("/templates/:id", requirePermission("SHIFT_MANAGE"), async (req, res, next) => {
  const data = updateTemplateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid shift", details: data.error.flatten() }); return; }
  try {
    const id = req.params.id as string;
    const updated = await prisma.shiftTemplate.updateMany({ where: { id, tenantId: tenantId(req) }, data: data.data });
    if (!updated.count) { res.status(404).json({ error: "Shift not found" }); return; }
    const template = await prisma.shiftTemplate.findUniqueOrThrow({ where: { id } });
    res.json({ template });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "A shift with this name already exists" }); return; }
    next(error);
  }
});

shiftsRouter.delete("/templates/:id", requirePermission("SHIFT_MANAGE"), async (req, res) => {
  const tid = tenantId(req);
  const existing = await prisma.shiftTemplate.findFirst({ where: { id: req.params.id as string, tenantId: tid } });
  if (!existing) { res.status(404).json({ error: "Shift not found" }); return; }
  const inUse = await prisma.rotationSlot.findFirst({ where: { shiftTemplateId: existing.id } });
  if (inUse) { res.status(409).json({ error: "This shift is assigned to at least one employee's rotation — remove it from their rotation first" }); return; }
  await prisma.shiftTemplate.delete({ where: { id: existing.id } });
  res.status(204).send();
});

const slotSchema = z.object({ shiftTemplateId: z.string().trim().min(1), days: z.coerce.number().int().min(1).max(90) });
const rotationSchema = z.object({
  anchorDate: z.coerce.date(),
  slots: z.array(slotSchema).min(1).max(20),
});

/** An employee's rotation, resolved for display: config plus what shift
 * applies right now (null = unrestricted, no rotation configured). */
shiftsRouter.get("/employees/:employeeId/rotation", async (req, res) => {
  const tid = tenantId(req);
  const employee = await prisma.employee.findFirst({ where: { id: req.params.employeeId as string, tenantId: tid }, select: { id: true } });
  if (!employee) { res.status(404).json({ error: "Employee not found" }); return; }
  const rotation = await prisma.employeeShiftRotation.findUnique({
    where: { employeeId: employee.id },
    include: { slots: { include: { shiftTemplate: true }, orderBy: { position: "asc" } } },
  });
  const currentShift = await resolveShiftFor(tid, employee.id);
  res.json({ rotation, currentShift, currentlyClockedIn: currentShift ? isWithinShift(currentShift) : null });
});

/** Replaces the employee's whole rotation in one call — rotations are edited
 * as a unit (change the pattern, not one slot at a time). */
shiftsRouter.put("/employees/:employeeId/rotation", requirePermission("SHIFT_MANAGE"), async (req, res, next) => {
  const tid = tenantId(req);
  const employee = await prisma.employee.findFirst({ where: { id: req.params.employeeId as string, tenantId: tid }, select: { id: true } });
  if (!employee) { res.status(404).json({ error: "Employee not found" }); return; }
  const data = rotationSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid rotation", details: data.error.flatten() }); return; }
  const templateIds = data.data.slots.map((s) => s.shiftTemplateId);
  const validTemplates = await prisma.shiftTemplate.count({ where: { id: { in: templateIds }, tenantId: tid } });
  if (validTemplates !== new Set(templateIds).size) { res.status(400).json({ error: "One or more shifts in this rotation were not found" }); return; }

  try {
    const cycleLengthDays = data.data.slots.reduce((sum, s) => sum + s.days, 0);
    let position = 0;
    const slotRows = data.data.slots.map((s) => {
      const row = { shiftTemplateId: s.shiftTemplateId, position, days: s.days };
      position += s.days;
      return row;
    });
    const rotation = await prisma.$transaction(async (tx) => {
      await tx.employeeShiftRotation.upsert({
        where: { employeeId: employee.id },
        create: { tenantId: tid, employeeId: employee.id, anchorDate: data.data.anchorDate, cycleLengthDays },
        update: { anchorDate: data.data.anchorDate, cycleLengthDays },
      });
      const current = await tx.employeeShiftRotation.findUniqueOrThrow({ where: { employeeId: employee.id } });
      await tx.rotationSlot.deleteMany({ where: { rotationId: current.id } });
      await tx.rotationSlot.createMany({ data: slotRows.map((row) => ({ ...row, rotationId: current.id })) });
      return tx.employeeShiftRotation.findUniqueOrThrow({
        where: { id: current.id },
        include: { slots: { include: { shiftTemplate: true }, orderBy: { position: "asc" } } },
      });
    });
    res.json({ rotation });
  } catch (error) {
    next(error);
  }
});

shiftsRouter.delete("/employees/:employeeId/rotation", requirePermission("SHIFT_MANAGE"), async (req, res) => {
  const tid = tenantId(req);
  const employee = await prisma.employee.findFirst({ where: { id: req.params.employeeId as string, tenantId: tid }, select: { id: true } });
  if (!employee) { res.status(404).json({ error: "Employee not found" }); return; }
  await prisma.employeeShiftRotation.deleteMany({ where: { employeeId: employee.id } });
  res.status(204).send();
});

const overrideSchema = z.object({ date: z.coerce.date(), shiftTemplateId: z.string().trim().min(1).nullable(), reason: z.string().trim().max(200).optional() });

/** Sets (or clears, with shiftTemplateId: null) a one-day exception to the
 * employee's computed rotation, without disturbing the rotation itself. */
shiftsRouter.put("/employees/:employeeId/overrides", requirePermission("SHIFT_MANAGE"), async (req, res, next) => {
  const tid = tenantId(req);
  const employee = await prisma.employee.findFirst({ where: { id: req.params.employeeId as string, tenantId: tid }, select: { id: true } });
  if (!employee) { res.status(404).json({ error: "Employee not found" }); return; }
  const data = overrideSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid override", details: data.error.flatten() }); return; }
  if (data.data.shiftTemplateId) {
    const ok = await prisma.shiftTemplate.findFirst({ where: { id: data.data.shiftTemplateId, tenantId: tid }, select: { id: true } });
    if (!ok) { res.status(400).json({ error: "Shift not found" }); return; }
  }
  try {
    const override = await prisma.employeeShiftOverride.upsert({
      where: { employeeId_date: { employeeId: employee.id, date: data.data.date } },
      create: { tenantId: tid, employeeId: employee.id, date: data.data.date, shiftTemplateId: data.data.shiftTemplateId, reason: data.data.reason },
      update: { shiftTemplateId: data.data.shiftTemplateId, reason: data.data.reason },
      include: { shiftTemplate: true },
    });
    res.json({ override });
  } catch (error) {
    next(error);
  }
});
