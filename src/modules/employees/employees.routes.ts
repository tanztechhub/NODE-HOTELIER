import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { hashSecret } from "../../lib/hash.js";
import { requireModule } from "../../middleware/tenantContext.js";

export const employeesRouter = Router();
employeesRouter.use(requireModule("HR"));

const genders = ["MALE", "FEMALE", "OTHER"] as const;
const departments = ["RECEPTION", "HOUSEKEEPING", "KITCHEN", "SALES", "SERVICE_CENTER", "INVENTORY", "FINANCE", "MANAGEMENT", "MAINTENANCE", "SECURITY"] as const;
const employmentTypes = ["FULL_TIME", "PART_TIME", "CASUAL", "CONTRACT", "INTERN"] as const;
const statuses = ["ACTIVE", "ON_LEAVE", "SUSPENDED", "TERMINATED"] as const;
const salaryTypes = ["MONTHLY", "DAILY", "HOURLY"] as const;
const paymentMethods = ["BANK_TRANSFER", "MPESA", "CASH", "CHEQUE"] as const;

// Empty strings from optional form fields should be treated as "not provided",
// not as validation failures (e.g. an untouched email/date input).
const blankToUndefined = (v: unknown) => (typeof v === "string" && v.trim() === "" ? undefined : v);
const optionalText = (max: number) => z.preprocess(blankToUndefined, z.string().trim().max(max).optional());
const optionalEmail = z.preprocess(blankToUndefined, z.email().optional());
const optionalDate = z.preprocess(blankToUndefined, z.coerce.date().optional());
const optionalId = z.preprocess(blankToUndefined, z.string().trim().optional());

const createSchema = z.object({
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().min(1).max(60),
  gender: z.preprocess(blankToUndefined, z.enum(genders).optional()),
  dateOfBirth: optionalDate,
  nationalId: optionalText(30),
  photoUrl: optionalText(2000),
  phone: z.string().trim().min(1).max(30),
  alternativePhone: optionalText(30),
  email: optionalEmail,
  address: optionalText(255),
  department: z.enum(departments),
  jobTitle: z.string().trim().min(1).max(80),
  employmentType: z.enum(employmentTypes).default("FULL_TIME"),
  status: z.enum(statuses).default("ACTIVE"),
  dateHired: z.coerce.date(),
  supervisorId: optionalId,
  roleId: optionalId,
  salaryType: z.enum(salaryTypes).default("MONTHLY"),
  salaryAmount: z.coerce.number().min(0),
  paymentMethod: z.enum(paymentMethods).default("BANK_TRANSFER"),
  bankName: optionalText(80),
  bankAccountNumber: optionalText(40),
  mpesaNumber: optionalText(20),
  kraPin: optionalText(20),
  nssfNumber: optionalText(20),
  shaNumber: optionalText(20),
  employeeCode: z.string().trim().min(1).max(30),
  pin: z.string().trim().min(4).max(8),
  emergencyContactName: optionalText(80),
  emergencyContactPhone: optionalText(30),
});
const updateSchema = createSchema.partial().omit({ pin: true }).extend({ pin: z.string().trim().min(4).max(8).optional() });
const listSchema = z.object({
  search: z.string().trim().max(100).optional(),
  department: z.enum(departments).optional(),
  status: z.enum(statuses).optional(),
});

const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};

const publicFields = {
  id: true,
  firstName: true,
  lastName: true,
  gender: true,
  dateOfBirth: true,
  nationalId: true,
  photoUrl: true,
  phone: true,
  alternativePhone: true,
  email: true,
  address: true,
  department: true,
  jobTitle: true,
  employmentType: true,
  status: true,
  dateHired: true,
  supervisorId: true,
  supervisor: { select: { id: true, firstName: true, lastName: true } },
  roleId: true,
  role: { select: { id: true, name: true, allowedSections: true } },
  salaryType: true,
  salaryAmount: true,
  paymentMethod: true,
  bankName: true,
  bankAccountNumber: true,
  mpesaNumber: true,
  kraPin: true,
  nssfNumber: true,
  shaNumber: true,
  employeeCode: true,
  emergencyContactName: true,
  emergencyContactPhone: true,
  createdAt: true,
  updatedAt: true,
} as const;

async function assertSupervisorInTenant(supervisorId: string | undefined, tenant: string, selfId?: string) {
  if (!supervisorId) return;
  if (supervisorId === selfId) throw Object.assign(new Error("An employee cannot supervise themselves"), { status: 400 });
  const supervisor = await prisma.employee.findFirst({ where: { id: supervisorId, tenantId: tenant }, select: { id: true } });
  if (!supervisor) throw Object.assign(new Error("Selected supervisor was not found"), { status: 400 });
}

async function assertRoleInTenant(roleId: string | undefined, tenant: string) {
  if (!roleId) return;
  const role = await prisma.role.findFirst({ where: { id: roleId, tenantId: tenant }, select: { id: true } });
  if (!role) throw Object.assign(new Error("Selected role was not found"), { status: 400 });
}

employeesRouter.get("/", async (req, res) => {
  const query = listSchema.safeParse(req.query);
  if (!query.success) { res.status(400).json({ error: "Invalid employee filters", details: query.error.flatten() }); return; }
  const { search, department, status } = query.data;
  const where: Prisma.EmployeeWhereInput = {
    tenantId: tenantId(req),
    ...(department ? { department } : {}),
    ...(status ? { status } : {}),
    ...(search ? { OR: [
      { firstName: { contains: search, mode: "insensitive" } },
      { lastName: { contains: search, mode: "insensitive" } },
      { employeeCode: { contains: search, mode: "insensitive" } },
      { jobTitle: { contains: search, mode: "insensitive" } },
      { phone: { contains: search, mode: "insensitive" } },
    ] } : {}),
  };
  const [employees, total, active, onLeave, suspended, terminated] = await Promise.all([
    prisma.employee.findMany({ where, select: publicFields, orderBy: [{ firstName: "asc" }, { lastName: "asc" }] }),
    prisma.employee.count({ where: { tenantId: tenantId(req) } }),
    prisma.employee.count({ where: { tenantId: tenantId(req), status: "ACTIVE" } }),
    prisma.employee.count({ where: { tenantId: tenantId(req), status: "ON_LEAVE" } }),
    prisma.employee.count({ where: { tenantId: tenantId(req), status: "SUSPENDED" } }),
    prisma.employee.count({ where: { tenantId: tenantId(req), status: "TERMINATED" } }),
  ]);
  res.json({ employees, summary: { total, active, onLeave, suspended, terminated } });
});

employeesRouter.get("/:id", async (req, res) => {
  const employee = await prisma.employee.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, select: publicFields });
  if (!employee) { res.status(404).json({ error: "Employee not found" }); return; }
  res.json({ employee });
});

employeesRouter.post("/", async (req, res, next) => {
  const data = createSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid employee", details: data.error.flatten() }); return; }
  const { pin, supervisorId, roleId, ...employeeData } = data.data;
  try {
    await assertSupervisorInTenant(supervisorId, tenantId(req));
    await assertRoleInTenant(roleId, tenantId(req));
    const employee = await prisma.employee.create({
      data: { tenantId: tenantId(req), ...employeeData, supervisorId: supervisorId ?? null, roleId: roleId ?? null, pin: hashSecret(pin) },
      select: publicFields,
    });
    res.status(201).json({ employee });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "An employee with this code already exists" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

employeesRouter.patch("/:id", async (req, res, next) => {
  const data = updateSchema.safeParse(req.body);
  if (!data.success) { res.status(400).json({ error: "Invalid employee", details: data.error.flatten() }); return; }
  const { pin, supervisorId, roleId, ...employeeData } = data.data;
  try {
    if (supervisorId !== undefined) await assertSupervisorInTenant(supervisorId, tenantId(req), req.params.id);
    if (roleId !== undefined) await assertRoleInTenant(roleId, tenantId(req));
    const updated = await prisma.employee.updateMany({
      where: { id: req.params.id, tenantId: tenantId(req) },
      data: { ...employeeData, ...(supervisorId !== undefined ? { supervisorId: supervisorId ?? null } : {}), ...(roleId !== undefined ? { roleId: roleId ?? null } : {}), ...(pin ? { pin: hashSecret(pin) } : {}) },
    });
    if (!updated.count) { res.status(404).json({ error: "Employee not found" }); return; }
    res.json({ employee: await prisma.employee.findUniqueOrThrow({ where: { id: req.params.id }, select: publicFields }) });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") { res.status(409).json({ error: "An employee with this code already exists" }); return; }
    if (error instanceof Error && "status" in error) { res.status((error as Error & { status: number }).status).json({ error: error.message }); return; }
    next(error);
  }
});

employeesRouter.delete("/:id", async (req, res) => {
  const deleted = await prisma.employee.deleteMany({ where: { id: req.params.id, tenantId: tenantId(req) } });
  if (!deleted.count) { res.status(404).json({ error: "Employee not found" }); return; }
  res.status(204).send();
});
