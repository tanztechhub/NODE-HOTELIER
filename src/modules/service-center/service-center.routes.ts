import { Router } from "express";
import { z } from "zod";

import { prisma } from "../../lib/prisma.js";
import { requireModule } from "../../middleware/tenantContext.js";

export const serviceCenterRouter = Router();
serviceCenterRouter.use(requireModule("SERVICE_CENTER"));

const appointmentStatus = z.enum(["BOOKED", "CONFIRMED", "IN_PROGRESS", "COMPLETED", "CANCELLED", "NO_SHOW"]);
const paymentStatus = z.enum(["PENDING", "PAID", "REFUNDED", "FAILED"]);
const membershipStatus = z.enum(["ACTIVE", "PAUSED", "EXPIRED", "CANCELLED"]);
const membershipSchema = z.object({
  customerId: z.string().cuid(),
  planId: z.string().cuid(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date().optional(),
  status: membershipStatus.default("ACTIVE"),
});
const paymentMethodSchema = z.object({
  name: z.string().trim().min(2).max(60),
  isActive: z.boolean().default(true),
});
const membershipPlanSchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: z.string().trim().max(500).nullable().optional(),
  price: z.coerce.number().min(0).max(100_000_000),
  durationDays: z.coerce.number().int().min(1).max(3650),
  discountPercent: z.coerce.number().min(0).max(100).default(0),
  isActive: z.boolean().default(true),
});
const membershipPaymentSchema = z.object({
  membershipId: z.string().cuid(),
  paymentMethodId: z.string().cuid(),
  amount: z.coerce.number().positive().max(100_000_000),
  status: paymentStatus.default("PAID"),
  reference: z.string().trim().max(120).nullable().optional(),
  paidAt: z.coerce.date().nullable().optional(),
});
const providerSchema = z.object({
  name: z.string().trim().min(2).max(100),
  specialty: z.string().trim().max(120).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  isActive: z.boolean().default(true),
});
const scheduleSchema = z.object({
  providerId: z.string().cuid(),
  startsAt: z.coerce.date(),
  endsAt: z.coerce.date(),
  isAvailable: z.boolean().default(true),
  notes: z.string().trim().max(500).nullable().optional(),
});
const appointmentSchema = z.object({
  customerId: z.string().cuid(),
  serviceId: z.string().cuid(),
  providerId: z.string().cuid(),
  membershipId: z.string().cuid().nullable().optional(),
  paymentMethodId: z.string().cuid().nullable().optional(),
  startsAt: z.coerce.date(),
  status: appointmentStatus.default("BOOKED"),
  paymentStatus: paymentStatus.default("PENDING"),
  notes: z.string().trim().max(500).nullable().optional(),
});
const tenantId = (req: { tenantId?: string }) => {
  if (!req.tenantId) throw new Error("Tenant context is required");
  return req.tenantId;
};
const include = { customer: true, service: true, provider: true, membership: { include: { plan: true } }, paymentMethod: true } as const;
const membershipInclude = {
  customer: true,
  plan: true,
  payments: { include: { paymentMethod: true }, orderBy: { createdAt: "desc" as const } },
  _count: { select: { appointments: true } },
} as const;

serviceCenterRouter.get("/memberships", async (req, res) => {
  const tid = tenantId(req);
  const memberships = await prisma.membership.findMany({
    where: { tenantId: tid },
    include: membershipInclude,
    orderBy: { createdAt: "desc" },
  });
  const now = new Date();
  res.json({
    memberships,
    summary: {
      total: memberships.length,
      active: memberships.filter((item) => item.status === "ACTIVE" && item.endsAt >= now).length,
      expiringSoon: memberships.filter((item) => item.status === "ACTIVE" && item.endsAt >= now && item.endsAt <= new Date(now.getTime() + 30 * 86_400_000)).length,
      revenue: memberships.flatMap((item) => item.payments).filter((payment) => payment.status === "PAID").reduce((sum, payment) => sum + Number(payment.amount), 0),
    },
  });
});

serviceCenterRouter.get("/memberships/:id", async (req, res) => {
  const membership = await prisma.membership.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include: membershipInclude });
  if (!membership) { res.status(404).json({ error: "Membership not found" }); return; }
  res.json({ membership });
});

async function resolveMembership(tid: string, data: z.infer<typeof membershipSchema>) {
  const [customer, plan] = await Promise.all([
    prisma.customer.findFirst({ where: { id: data.customerId, tenantId: tid } }),
    prisma.membershipPlan.findFirst({ where: { id: data.planId, tenantId: tid } }),
  ]);
  if (!customer || !plan) return { error: "Choose a valid customer and membership plan" } as const;
  const endsAt = data.endsAt ?? new Date(data.startsAt.getTime() + plan.durationDays * 86_400_000);
  if (endsAt <= data.startsAt) return { error: "Membership end date must be after its start date" } as const;
  return { customer, plan, endsAt } as const;
}

serviceCenterRouter.post("/memberships", async (req, res) => {
  const parsed = membershipSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid membership", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const resolved = await resolveMembership(tid, parsed.data);
  if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
  const membership = await prisma.membership.create({
    data: { tenantId: tid, customerId: parsed.data.customerId, planId: parsed.data.planId, startsAt: parsed.data.startsAt, endsAt: resolved.endsAt, status: parsed.data.status },
    include: membershipInclude,
  });
  res.status(201).json({ membership });
});

serviceCenterRouter.patch("/memberships/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.membership.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!current) { res.status(404).json({ error: "Membership not found" }); return; }
  const parsed = membershipSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid membership", details: parsed.error.flatten() }); return; }
  const merged = membershipSchema.parse({ ...current, ...parsed.data });
  const resolved = await resolveMembership(tid, merged);
  if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
  const membership = await prisma.membership.update({
    where: { id: current.id },
    data: { ...parsed.data, endsAt: resolved.endsAt },
    include: membershipInclude,
  });
  res.json({ membership });
});

serviceCenterRouter.delete("/memberships/:id", async (req, res) => {
  const deleted = await prisma.membership.deleteMany({ where: { id: req.params.id, tenantId: tenantId(req) } });
  if (!deleted.count) { res.status(404).json({ error: "Membership not found" }); return; }
  res.status(204).send();
});

serviceCenterRouter.get("/membership-options", async (req, res) => {
  const tid = tenantId(req);
  const [customers, plans] = await Promise.all([
    prisma.customer.findMany({ where: { tenantId: tid }, orderBy: [{ firstName: "asc" }, { lastName: "asc" }] }),
    prisma.membershipPlan.findMany({ where: { tenantId: tid }, orderBy: { name: "asc" } }),
  ]);
  res.json({ customers, plans });
});

serviceCenterRouter.get("/membership-plans", async (req, res) => {
  const tid = tenantId(req);
  const membershipPlans = await prisma.membershipPlan.findMany({
    where: { tenantId: tid },
    include: { memberships: { select: { id: true, status: true, payments: { select: { amount: true, status: true } }, _count: { select: { appointments: true } } } } },
    orderBy: [{ isActive: "desc" }, { price: "asc" }],
  });
  res.json({ membershipPlans });
});

serviceCenterRouter.get("/membership-plans/:id", async (req, res) => {
  const membershipPlan = await prisma.membershipPlan.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include: { memberships: { include: { customer: true, payments: true } } } });
  if (!membershipPlan) { res.status(404).json({ error: "Membership plan not found" }); return; }
  res.json({ membershipPlan });
});

serviceCenterRouter.post("/membership-plans", async (req, res) => {
  const parsed = membershipPlanSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid membership plan", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const duplicate = await prisma.membershipPlan.findFirst({ where: { tenantId: tid, name: { equals: parsed.data.name, mode: "insensitive" } } });
  if (duplicate) { res.status(409).json({ error: "A membership plan with this name already exists" }); return; }
  const membershipPlan = await prisma.membershipPlan.create({ data: { tenantId: tid, ...parsed.data }, include: { memberships: true } });
  res.status(201).json({ membershipPlan });
});

serviceCenterRouter.patch("/membership-plans/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.membershipPlan.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!current) { res.status(404).json({ error: "Membership plan not found" }); return; }
  const parsed = membershipPlanSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid membership plan", details: parsed.error.flatten() }); return; }
  if (parsed.data.name) {
    const duplicate = await prisma.membershipPlan.findFirst({ where: { tenantId: tid, name: { equals: parsed.data.name, mode: "insensitive" }, id: { not: current.id } } });
    if (duplicate) { res.status(409).json({ error: "A membership plan with this name already exists" }); return; }
  }
  const membershipPlan = await prisma.membershipPlan.update({ where: { id: current.id }, data: parsed.data });
  res.json({ membershipPlan });
});

serviceCenterRouter.delete("/membership-plans/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.membershipPlan.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { _count: { select: { memberships: true } } } });
  if (!current) { res.status(404).json({ error: "Membership plan not found" }); return; }
  if (current._count.memberships) { res.status(409).json({ error: "This plan has customer memberships. Deactivate it instead of deleting it." }); return; }
  await prisma.membershipPlan.delete({ where: { id: current.id } });
  res.status(204).send();
});

const membershipPaymentInclude = {
  paymentMethod: true,
  membership: {
    include: {
      customer: true,
      plan: true,
      appointments: { include: { service: true, provider: true }, orderBy: { startsAt: "desc" as const } },
    },
  },
} as const;

serviceCenterRouter.get("/membership-payments", async (req, res) => {
  const tid = tenantId(req);
  const membershipPayments = await prisma.membershipPayment.findMany({ where: { tenantId: tid }, include: membershipPaymentInclude, orderBy: { createdAt: "desc" } });
  res.json({ membershipPayments });
});

serviceCenterRouter.get("/membership-payments/:id", async (req, res) => {
  const membershipPayment = await prisma.membershipPayment.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include: membershipPaymentInclude });
  if (!membershipPayment) { res.status(404).json({ error: "Membership payment not found" }); return; }
  res.json({ membershipPayment });
});

async function resolveMembershipPayment(tid: string, membershipId: string, paymentMethodId: string) {
  const [membership, paymentMethod] = await Promise.all([
    prisma.membership.findFirst({ where: { id: membershipId, tenantId: tid }, include: { plan: true, customer: true } }),
    prisma.paymentMethod.findFirst({ where: { id: paymentMethodId, tenantId: tid } }),
  ]);
  if (!membership) return { error: "Choose a valid customer membership" } as const;
  if (!paymentMethod) return { error: "Choose a valid payment method" } as const;
  return { membership, paymentMethod } as const;
}

serviceCenterRouter.post("/membership-payments", async (req, res) => {
  const parsed = membershipPaymentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid membership payment", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const resolved = await resolveMembershipPayment(tid, parsed.data.membershipId, parsed.data.paymentMethodId);
  if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
  const paidAt = parsed.data.status === "PAID" ? (parsed.data.paidAt ?? new Date()) : parsed.data.paidAt;
  const membershipPayment = await prisma.membershipPayment.create({ data: { tenantId: tid, ...parsed.data, paidAt }, include: membershipPaymentInclude });
  res.status(201).json({ membershipPayment });
});

serviceCenterRouter.patch("/membership-payments/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.membershipPayment.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!current) { res.status(404).json({ error: "Membership payment not found" }); return; }
  const parsed = membershipPaymentSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid membership payment", details: parsed.error.flatten() }); return; }
  const membershipId = parsed.data.membershipId ?? current.membershipId;
  const paymentMethodId = parsed.data.paymentMethodId ?? current.paymentMethodId;
  const resolved = await resolveMembershipPayment(tid, membershipId, paymentMethodId);
  if ("error" in resolved) { res.status(400).json({ error: resolved.error }); return; }
  const nextStatus = parsed.data.status ?? current.status;
  const paidAt = parsed.data.paidAt !== undefined ? parsed.data.paidAt : nextStatus === "PAID" && !current.paidAt ? new Date() : current.paidAt;
  const membershipPayment = await prisma.membershipPayment.update({ where: { id: current.id }, data: { ...parsed.data, paidAt }, include: membershipPaymentInclude });
  res.json({ membershipPayment });
});

serviceCenterRouter.delete("/membership-payments/:id", async (req, res) => {
  const deleted = await prisma.membershipPayment.deleteMany({ where: { id: req.params.id, tenantId: tenantId(req) } });
  if (!deleted.count) { res.status(404).json({ error: "Membership payment not found" }); return; }
  res.status(204).send();
});

serviceCenterRouter.get("/membership-payment-options", async (req, res) => {
  const tid = tenantId(req);
  const [memberships, paymentMethods] = await Promise.all([
    prisma.membership.findMany({ where: { tenantId: tid }, include: { customer: true, plan: true, appointments: { select: { id: true, startsAt: true, service: { select: { name: true } } } } }, orderBy: { createdAt: "desc" } }),
    prisma.paymentMethod.findMany({ where: { tenantId: tid, isActive: true }, orderBy: { name: "asc" } }),
  ]);
  res.json({ memberships, paymentMethods });
});

const providerInclude = {
  schedules: { orderBy: { startsAt: "asc" as const } },
  appointments: { include: { customer: true, service: true }, orderBy: { startsAt: "desc" as const }, take: 20 },
  _count: { select: { schedules: true, appointments: true } },
} as const;

serviceCenterRouter.get("/providers", async (req, res) => {
  const providers = await prisma.serviceProvider.findMany({ where: { tenantId: tenantId(req) }, include: providerInclude, orderBy: [{ isActive: "desc" }, { name: "asc" }] });
  res.json({ providers });
});

serviceCenterRouter.get("/providers/:id", async (req, res) => {
  const provider = await prisma.serviceProvider.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include: providerInclude });
  if (!provider) { res.status(404).json({ error: "Provider not found" }); return; }
  res.json({ provider });
});

serviceCenterRouter.post("/providers", async (req, res) => {
  const parsed = providerSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid provider", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const duplicate = await prisma.serviceProvider.findFirst({ where: { tenantId: tid, name: { equals: parsed.data.name, mode: "insensitive" } } });
  if (duplicate) { res.status(409).json({ error: "A provider with this name already exists" }); return; }
  const provider = await prisma.serviceProvider.create({ data: { tenantId: tid, ...parsed.data }, include: providerInclude });
  res.status(201).json({ provider });
});

serviceCenterRouter.patch("/providers/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.serviceProvider.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!current) { res.status(404).json({ error: "Provider not found" }); return; }
  const parsed = providerSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid provider", details: parsed.error.flatten() }); return; }
  if (parsed.data.name) {
    const duplicate = await prisma.serviceProvider.findFirst({ where: { tenantId: tid, name: { equals: parsed.data.name, mode: "insensitive" }, id: { not: current.id } } });
    if (duplicate) { res.status(409).json({ error: "A provider with this name already exists" }); return; }
  }
  const provider = await prisma.serviceProvider.update({ where: { id: current.id }, data: parsed.data, include: providerInclude });
  res.json({ provider });
});

serviceCenterRouter.delete("/providers/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.serviceProvider.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { _count: { select: { appointments: true } } } });
  if (!current) { res.status(404).json({ error: "Provider not found" }); return; }
  if (current._count.appointments) { res.status(409).json({ error: "This provider has appointment history. Deactivate them instead of deleting them." }); return; }
  await prisma.serviceProvider.delete({ where: { id: current.id } });
  res.status(204).send();
});

serviceCenterRouter.get("/schedules", async (req, res) => {
  const tid = tenantId(req);
  const [schedules, appointments] = await Promise.all([
    prisma.providerSchedule.findMany({ where: { tenantId: tid }, include: { provider: true }, orderBy: { startsAt: "asc" } }),
    prisma.appointment.findMany({ where: { tenantId: tid }, include: { customer: true, service: true, provider: true, membership: { include: { plan: true } } }, orderBy: { startsAt: "asc" } }),
  ]);
  res.json({ schedules, appointments });
});

async function resolveSchedule(tid: string, data: z.infer<typeof scheduleSchema>, excludeId?: string) {
  if (data.endsAt <= data.startsAt) return { error: "Schedule end time must be after its start time" } as const;
  const provider = await prisma.serviceProvider.findFirst({ where: { id: data.providerId, tenantId: tid } });
  if (!provider) return { error: "Choose a valid provider" } as const;
  const overlap = await prisma.providerSchedule.findFirst({ where: { tenantId: tid, providerId: data.providerId, startsAt: { lt: data.endsAt }, endsAt: { gt: data.startsAt }, ...(excludeId ? { id: { not: excludeId } } : {}) } });
  if (overlap) return { error: `${provider.name} already has an overlapping schedule` } as const;
  return { provider } as const;
}

serviceCenterRouter.post("/schedules", async (req, res) => {
  const parsed = scheduleSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid schedule", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const resolved = await resolveSchedule(tid, parsed.data);
  if ("error" in resolved) { res.status(409).json({ error: resolved.error }); return; }
  const schedule = await prisma.providerSchedule.create({ data: { tenantId: tid, ...parsed.data }, include: { provider: true } });
  res.status(201).json({ schedule });
});

serviceCenterRouter.patch("/schedules/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.providerSchedule.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!current) { res.status(404).json({ error: "Schedule not found" }); return; }
  const parsed = scheduleSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid schedule", details: parsed.error.flatten() }); return; }
  const merged = scheduleSchema.parse({ ...current, ...parsed.data });
  const resolved = await resolveSchedule(tid, merged, current.id);
  if ("error" in resolved) { res.status(409).json({ error: resolved.error }); return; }
  const schedule = await prisma.providerSchedule.update({ where: { id: current.id }, data: parsed.data, include: { provider: true } });
  res.json({ schedule });
});

serviceCenterRouter.delete("/schedules/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.providerSchedule.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!current) { res.status(404).json({ error: "Schedule not found" }); return; }
  const bookings = await prisma.appointment.count({ where: { tenantId: tid, providerId: current.providerId, status: { notIn: ["CANCELLED", "NO_SHOW"] }, startsAt: { lt: current.endsAt }, endsAt: { gt: current.startsAt } } });
  if (bookings) { res.status(409).json({ error: "This schedule contains customer appointments. Move or cancel them before deleting it." }); return; }
  await prisma.providerSchedule.delete({ where: { id: current.id } });
  res.status(204).send();
});

serviceCenterRouter.get("/schedule-options", async (req, res) => {
  const providers = await prisma.serviceProvider.findMany({ where: { tenantId: tenantId(req), isActive: true }, orderBy: { name: "asc" } });
  res.json({ providers });
});

serviceCenterRouter.get("/payment-methods", async (req, res) => {
  const tid = tenantId(req);
  const paymentMethods = await prisma.paymentMethod.findMany({
    where: { tenantId: tid },
    include: { _count: { select: { membershipPayments: true, appointments: true } } },
    orderBy: [{ isActive: "desc" }, { name: "asc" }],
  });
  res.json({ paymentMethods });
});

serviceCenterRouter.get("/payment-methods/:id", async (req, res) => {
  const paymentMethod = await prisma.paymentMethod.findFirst({
    where: { id: req.params.id, tenantId: tenantId(req) },
    include: { _count: { select: { membershipPayments: true, appointments: true } } },
  });
  if (!paymentMethod) { res.status(404).json({ error: "Payment method not found" }); return; }
  res.json({ paymentMethod });
});

serviceCenterRouter.post("/payment-methods", async (req, res) => {
  const parsed = paymentMethodSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid payment method", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const duplicate = await prisma.paymentMethod.findFirst({ where: { tenantId: tid, name: { equals: parsed.data.name, mode: "insensitive" } } });
  if (duplicate) { res.status(409).json({ error: "A payment method with this name already exists" }); return; }
  const code = `SC_${parsed.data.name.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_|_$/g, "")}`;
  const paymentMethod = await prisma.paymentMethod.create({ data: { tenantId: tid, code, ...parsed.data }, include: { _count: { select: { membershipPayments: true, appointments: true } } } });
  res.status(201).json({ paymentMethod });
});

serviceCenterRouter.patch("/payment-methods/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.paymentMethod.findFirst({ where: { id: req.params.id, tenantId: tid } });
  if (!current) { res.status(404).json({ error: "Payment method not found" }); return; }
  const parsed = paymentMethodSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid payment method", details: parsed.error.flatten() }); return; }
  if (parsed.data.name) {
    const duplicate = await prisma.paymentMethod.findFirst({ where: { tenantId: tid, name: { equals: parsed.data.name, mode: "insensitive" }, id: { not: current.id } } });
    if (duplicate) { res.status(409).json({ error: "A payment method with this name already exists" }); return; }
  }
  const paymentMethod = await prisma.paymentMethod.update({ where: { id: current.id }, data: parsed.data, include: { _count: { select: { membershipPayments: true, appointments: true } } } });
  res.json({ paymentMethod });
});

serviceCenterRouter.delete("/payment-methods/:id", async (req, res) => {
  const tid = tenantId(req);
  const current = await prisma.paymentMethod.findFirst({ where: { id: req.params.id, tenantId: tid }, include: { _count: { select: { membershipPayments: true, appointments: true } } } });
  if (!current) { res.status(404).json({ error: "Payment method not found" }); return; }
  if (current._count.membershipPayments || current._count.appointments) {
    res.status(409).json({ error: "This method has transaction history. Deactivate it instead of deleting it." }); return;
  }
  await prisma.paymentMethod.delete({ where: { id: current.id } });
  res.status(204).send();
});

serviceCenterRouter.get("/appointments", async (req, res) => {
  const tid = tenantId(req);
  const appointments = await prisma.appointment.findMany({ where: { tenantId: tid }, include, orderBy: { startsAt: "asc" } });
  const now = new Date();
  res.json({ appointments, summary: { total: appointments.length, today: appointments.filter((item) => item.startsAt.toDateString() === now.toDateString() && !["CANCELLED", "NO_SHOW"].includes(item.status)).length, upcoming: appointments.filter((item) => item.startsAt > now && !["CANCELLED", "NO_SHOW"].includes(item.status)).length, completed: appointments.filter((item) => item.status === "COMPLETED").length } });
});

serviceCenterRouter.get("/appointments/:id", async (req, res) => {
  const appointment = await prisma.appointment.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) }, include });
  if (!appointment) { res.status(404).json({ error: "Appointment not found" }); return; }
  res.json({ appointment });
});

async function resolveAppointment(tid: string, data: z.infer<typeof appointmentSchema>, excludeId?: string) {
  const [customer, service, provider, membership, paymentMethod] = await Promise.all([
    prisma.customer.findFirst({ where: { id: data.customerId, tenantId: tid } }),
    prisma.serviceCenterService.findFirst({ where: { id: data.serviceId, tenantId: tid, isActive: true } }),
    prisma.serviceProvider.findFirst({ where: { id: data.providerId, tenantId: tid, isActive: true } }),
    data.membershipId ? prisma.membership.findFirst({ where: { id: data.membershipId, tenantId: tid, customerId: data.customerId, status: "ACTIVE", startsAt: { lte: data.startsAt }, endsAt: { gte: data.startsAt } }, include: { plan: true } }) : null,
    data.paymentMethodId ? prisma.paymentMethod.findFirst({ where: { id: data.paymentMethodId, tenantId: tid, isActive: true } }) : null,
  ]);
  if (!customer || !service || !provider) return { error: "Choose a valid customer, service, and provider" } as const;
  if (data.membershipId && !membership) return { error: "The selected membership is not active for this customer and appointment date" } as const;
  if (data.paymentMethodId && !paymentMethod) return { error: "Choose an active payment method" } as const;
  const endsAt = new Date(data.startsAt.getTime() + service.durationMinutes * 60_000);
  const schedule = await prisma.providerSchedule.findFirst({ where: { tenantId: tid, providerId: provider.id, isAvailable: true, startsAt: { lte: data.startsAt }, endsAt: { gte: endsAt } } });
  if (!schedule) return { error: `${provider.name} is not scheduled for this time` } as const;
  const conflict = await prisma.appointment.findFirst({ where: { tenantId: tid, providerId: provider.id, status: { notIn: ["CANCELLED", "NO_SHOW"] }, startsAt: { lt: endsAt }, endsAt: { gt: data.startsAt }, ...(excludeId ? { id: { not: excludeId } } : {}) } });
  if (conflict) return { error: `${provider.name} already has an appointment during this time` } as const;
  const discount = membership ? Number(membership.plan.discountPercent) : 0;
  return { customer, service, provider, membership, paymentMethod, endsAt, amount: Number(service.price) * (1 - discount / 100) } as const;
}

serviceCenterRouter.post("/appointments", async (req, res) => {
  const parsed = appointmentSchema.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid appointment", details: parsed.error.flatten() }); return; }
  const tid = tenantId(req);
  const resolved = await resolveAppointment(tid, parsed.data);
  if ("error" in resolved) { res.status(409).json({ error: resolved.error }); return; }
  const appointment = await prisma.appointment.create({ data: { tenantId: tid, ...parsed.data, membershipId: resolved.membership?.id, paymentMethodId: resolved.paymentMethod?.id, endsAt: resolved.endsAt, amount: resolved.amount }, include });
  res.status(201).json({ appointment });
});

serviceCenterRouter.patch("/appointments/:id", async (req, res) => {
  const current = await prisma.appointment.findFirst({ where: { id: req.params.id, tenantId: tenantId(req) } });
  if (!current) { res.status(404).json({ error: "Appointment not found" }); return; }
  const parsed = appointmentSchema.partial().safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: "Invalid appointment", details: parsed.error.flatten() }); return; }
  const merged = appointmentSchema.parse({ ...current, ...parsed.data });
  const resolved = await resolveAppointment(current.tenantId, merged, current.id);
  if ("error" in resolved) { res.status(409).json({ error: resolved.error }); return; }
  const appointment = await prisma.appointment.update({ where: { id: current.id }, data: { ...parsed.data, membershipId: resolved.membership?.id, paymentMethodId: resolved.paymentMethod?.id, endsAt: resolved.endsAt, amount: resolved.amount }, include });
  res.json({ appointment });
});

serviceCenterRouter.delete("/appointments/:id", async (req, res) => {
  const deleted = await prisma.appointment.deleteMany({ where: { id: req.params.id, tenantId: tenantId(req) } });
  if (!deleted.count) { res.status(404).json({ error: "Appointment not found" }); return; }
  res.status(204).send();
});

serviceCenterRouter.get("/appointment-options", async (req, res) => {
  const tid = tenantId(req);
  const [customers, services, providers, schedules, memberships, paymentMethods, membershipPayments] = await Promise.all([
    prisma.customer.findMany({ where: { tenantId: tid }, orderBy: [{ firstName: "asc" }, { lastName: "asc" }] }),
    prisma.serviceCenterService.findMany({ where: { tenantId: tid, isActive: true }, orderBy: { name: "asc" } }),
    prisma.serviceProvider.findMany({ where: { tenantId: tid, isActive: true }, orderBy: { name: "asc" } }),
    prisma.providerSchedule.findMany({ where: { tenantId: tid, isAvailable: true, endsAt: { gte: new Date() } }, include: { provider: true }, orderBy: { startsAt: "asc" } }),
    prisma.membership.findMany({ where: { tenantId: tid }, include: { customer: true, plan: true }, orderBy: { endsAt: "desc" } }),
    prisma.paymentMethod.findMany({ where: { tenantId: tid, isActive: true }, orderBy: { name: "asc" } }),
    prisma.membershipPayment.findMany({ where: { tenantId: tid }, include: { membership: { include: { customer: true, plan: true } }, paymentMethod: true }, orderBy: { createdAt: "desc" }, take: 100 }),
  ]);
  res.json({ customers, services, providers, schedules, memberships, paymentMethods, membershipPayments });
});
